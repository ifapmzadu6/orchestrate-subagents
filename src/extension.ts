import * as vscode from 'vscode';
import { z } from 'zod';

const AgentSchema = z.object({
	id: z.string().regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, numbers, dot, underscore, or dash.'),
	systemPrompt: z.string().min(1, 'systemPrompt must not be empty'),
	userPrompt: z.string().min(1, 'userPrompt must not be empty'),
	maxTurns: z.number().int().min(1).max(100).default(50)
});

const OrchestratorInputSchema = z.object({
	agents: z.array(AgentSchema).min(1, 'Provide at least one agent definition').max(3, 'Provide no more than three agents')
});

type AgentDefinition = z.infer<typeof AgentSchema>;
type OrchestratorInput = z.infer<typeof OrchestratorInputSchema>;

interface SubagentResult {
	agent: AgentDefinition;
	turns: number;
	toolInvocations: number;
	messages: vscode.LanguageModelChatMessage[];
	accumulatedText: string;
}

class OrchestrateSubagentsTool implements vscode.LanguageModelTool<OrchestratorInput> {
	private readonly output: vscode.OutputChannel;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.output = vscode.window.createOutputChannel('Orchestrate Subagents');
		this.context.subscriptions.push(this.output);
	}

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<OrchestratorInput>): vscode.PreparedToolInvocation {
		const parsed = OrchestratorInputSchema.safeParse(options.input);
		if (!parsed.success) {
			return {
				invocationMessage: 'Orchestrate Subagents: input looks invalid. Review arguments before continuing.'
			};
		}

		const agentCount = parsed.data.agents.length;
		return {
			invocationMessage: `Launching ${agentCount} Copilot subagent${agentCount > 1 ? 's' : ''}.`
		};
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<OrchestratorInput>,
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		const parsed = OrchestratorInputSchema.safeParse(options.input);
		if (!parsed.success) {
			const flattened = parsed.error.flatten();
			const messages = [
				...flattened.formErrors,
				...Object.entries(flattened.fieldErrors).flatMap(([field, errors]) => errors?.map((err) => `${field}: ${err}`) ?? [])
			];
			const message = `Failed to parse subagent request:\n- ${messages.join('\n- ')}`;
			this.output.appendLine(message);
			return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(message)]);
		}

		const input = parsed.data;
		const model = await this.resolveModel();

		const availableTools = vscode.lm.tools
			.filter((toolInfo) => toolInfo.name !== 'orchestrateSubagents')
			.map((toolInfo): vscode.LanguageModelChatTool => ({
				name: toolInfo.name,
				description: toolInfo.description,
				inputSchema: toolInfo.inputSchema
			}));

		this.log(`Starting subagents: ${input.agents.map((agent) => agent.id).join(', ')}`);

		const tasks: Array<Promise<SubagentResult>> = input.agents.map((agent) =>
			this.runSubagent(
				agent.id,
				agent.systemPrompt,
				agent.userPrompt,
				agent.maxTurns,
				model,
				availableTools,
				token
			)
		);
		const results = await Promise.all(tasks);

		const responseJson = this.buildAggregatedResponse(results);
		this.log('Completed subagents.');

		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(responseJson)]);
	}

	private async runSubagent(
		agentId: string,
		systemPrompt: string,
		userPrompt: string,
		maxTurns: number,
		model: vscode.LanguageModelChat,
		availableTools: vscode.LanguageModelChatTool[],
		token: vscode.CancellationToken
	): Promise<SubagentResult> {
		this.log('Starting execution', agentId);

		const initialMessage = vscode.LanguageModelChatMessage.User(this.composeInitialPrompt(agentId, systemPrompt, userPrompt));
		try {
			const tokens = await model.countTokens(initialMessage, token);
			this.log(`Initial prompt approx ${tokens} tokens`, agentId);
		} catch (error) {
			this.log(`Failed to estimate initial prompt tokens: ${this.toErrorMessage(error)}`, agentId);
		}

		const messages: vscode.LanguageModelChatMessage[] = [initialMessage];

		let accumulatedText = '';
		let toolInvocations = 0;
		let turns = 0;
		let exhaustedTurnBudget = true;

		for (let turn = 0; turn < maxTurns; turn++) {
			this.throwIfCancelled(token);
			const promptTokens = await this.countConversationTokens(model, messages, token);
			this.log(
				`Turn ${turn + 1} sending request (approx ${promptTokens} tokens across ${messages.length} message(s))`,
				agentId
			);

			let response: vscode.LanguageModelChatResponse;
			try {
				response = await model.sendRequest(
					messages,
					{
						justification: `Orchestrate Subagents tool executing agent "${agentId}".`,
						tools: availableTools
					},
					token
				);
			} catch (error) {
				this.log(`Turn ${turn + 1} failed: ${this.toErrorMessage(error)}`, agentId);
				throw error;
			}

			const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
			const toolCalls: vscode.LanguageModelToolCallPart[] = [];
			let textBuffer = '';

			for await (const part of response.stream) {
				if (part instanceof vscode.LanguageModelTextPart) {
					assistantParts.push(part);
					textBuffer += part.value;
					continue;
				}

				if (part instanceof vscode.LanguageModelToolCallPart) {
					assistantParts.push(part);
					toolCalls.push(part);
				}
			}

			if (assistantParts.length > 0) {
				messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
				turns += 1;
			}

			if (textBuffer.trim().length > 0) {
				this.log(`Turn ${turns} received ${textBuffer.trim().length} chars of assistant text`, agentId);
				accumulatedText = `${accumulatedText}\n\n${textBuffer}`.trim();
			}

			if (toolCalls.length === 0) {
				this.log(`Turn ${turns} produced no tool calls; ending agent run`, agentId);
				exhaustedTurnBudget = false;
				break;
			}

			this.log(`Turn ${turns} requested ${toolCalls.length} tool call(s)`, agentId);

			for (const call of toolCalls) {
				this.throwIfCancelled(token);
				this.log(`Invoking tool ${call.name}`, agentId);

				let result: vscode.LanguageModelToolResult;
				try {
					result = await vscode.lm.invokeTool(
						call.name,
						{
							toolInvocationToken: undefined,
							input: call.input
						},
						token
					);
				} catch (error) {
					this.log(`Tool ${call.name} failed: ${this.toErrorMessage(error)}`, agentId);
					throw error;
				}

				const resultPart = new vscode.LanguageModelToolResultPart(call.callId, result.content);
				const toolMessage = vscode.LanguageModelChatMessage.User([resultPart]);
				try {
					const tokens = await model.countTokens(toolMessage, token);
					this.log(
						`Tool ${call.name} completed (parts=${result.content.length}, approx ${tokens} tokens)`,
						agentId
					);
				} catch (error) {
					this.log(
						`Tool ${call.name} completed (parts=${result.content.length}). Token estimation failed: ${this.toErrorMessage(error)}`,
						agentId
					);
				}

				messages.push(toolMessage);
				toolInvocations += 1;
			}
		}

		if (exhaustedTurnBudget) {
			this.log('Turn budget exhausted; requesting final summary without tools', agentId);
			const summaryPrompt = this.buildFinalSummaryPrompt();
			messages.push(vscode.LanguageModelChatMessage.User(summaryPrompt));

			try {
				const summaryResponse = await model.sendRequest(
					messages,
					{
						justification: `Orchestrate Subagents tool executing final summary for agent "${agentId}".`,
						tools: []
					},
					token
				);

				const summaryParts: vscode.LanguageModelTextPart[] = [];
				for await (const part of summaryResponse.stream) {
					if (part instanceof vscode.LanguageModelTextPart) {
						summaryParts.push(part);
					} else if (part instanceof vscode.LanguageModelToolCallPart) {
						this.log(
							`Final summary attempted to call tool ${part.name}; ignoring as tools are disabled`,
							agentId
						);
					}
				}

				if (summaryParts.length > 0) {
					messages.push(vscode.LanguageModelChatMessage.Assistant(summaryParts));
					const combined = summaryParts.map((part) => part.value).join('');
					if (combined.trim().length > 0) {
						accumulatedText = `${accumulatedText}\n\n${combined}`.trim();
						this.log(`Final summary produced ${combined.trim().length} chars`, agentId);
					}
				}
			} catch (error) {
				this.log(`Final summary request failed: ${this.toErrorMessage(error)}`, agentId);
			}
		}

		this.log(`Finished execution after ${turns} turn(s) and ${toolInvocations} tool call(s)`, agentId);

		return {
			agent: { id: agentId, systemPrompt, userPrompt, maxTurns },
			turns,
			toolInvocations,
			messages,
			accumulatedText
		};
	}

	private composeInitialPrompt(agentId: string, systemPrompt: string, userPrompt: string): string {
		return [
			'<orchestrateSubagent>',
			`  <identity>${agentId}</identity>`,
			'  <role>You are an autonomous Copilot subagent. Obey the provided instructions, use tools responsibly, and report concise, actionable findings.</role>',
			'  <systemInstructions>',
			this.escapeForXmlWithIndent(systemPrompt, 4),
			'  </systemInstructions>',
			'  <task>',
			this.escapeForXmlWithIndent(userPrompt, 4),
			'  </task>',
			'  <responseGuidelines>',
			'    <item>Prefer structured, factual answers.</item>',
			'    <item>Clearly cite files or resources you relied on.</item>',
			'    <item>Only call tools when strictly necessary.</item>',
			'  </responseGuidelines>',
			'</orchestrateSubagent>'
		].join('\n');
	}

	private buildAggregatedResponse(results: SubagentResult[]): string {
		const summary = {
			subagents: results.map((result) => ({
				id: result.agent.id,
				systemPrompt: result.agent.systemPrompt,
				userPrompt: result.agent.userPrompt,
				maxTurns: result.agent.maxTurns,
				turnsTaken: result.turns,
				toolCalls: result.toolInvocations,
				summary: result.accumulatedText
			}))
		};

		return JSON.stringify(summary, null, 2);
	}

	private async resolveModel(): Promise<vscode.LanguageModelChat> {
		const FIXED_MODEL_ID = 'gpt-5-mini';
		const models = await vscode.lm.selectChatModels({ id: FIXED_MODEL_ID });
		if (models.length === 0) {
			throw new Error(`Required chat model "${FIXED_MODEL_ID}" is unavailable. Ensure Copilot gpt-5-mini is enabled for your account.`);
		}

		const model = models[0];
		const accessInfo = this.context.languageModelAccessInformation;
		const canSend = accessInfo.canSendRequest(model);

		if (canSend === false) {
			throw new Error('Language model access denied for the selected model. Ask the user to enable Copilot for extensions.');
		}

		return model;
	}

	private escapeForXml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;');
	}

	private escapeForXmlWithIndent(text: string, indentSpaces: number): string {
		const indent = ' '.repeat(indentSpaces);
		return text
			.split(/\r?\n/)
			.map((line) => `${indent}${this.escapeForXml(line.trim())}`)
			.join('\n');
	}

	private buildFinalSummaryPrompt(): string {
		return [
			'<orchestrateSubagentSummary>',
			'  <status>turn-budget-exhausted</status>',
			'  <instruction>Summarize the conversation and tool outputs completed so far.</instruction>',
			'  <instruction>Focus on key findings and recommended next steps.</instruction>',
			'  <instruction>Do not call additional tools.</instruction>',
			'</orchestrateSubagentSummary>'
		].join('\n');
	}

	private throwIfCancelled(token: vscode.CancellationToken) {
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
	}

	private log(message: string, agentId?: string) {
		const timestamp = new Date().toISOString();
		const agentSuffix = agentId ? ` [${agentId}]` : '';
		this.output.appendLine(`[${timestamp}]${agentSuffix} ${message}`);
	}

	private toErrorMessage(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		try {
			return JSON.stringify(error);
		} catch {
			return String(error);
		}
	}

	private async countConversationTokens(
		model: vscode.LanguageModelChat,
		messages: vscode.LanguageModelChatMessage[],
		token: vscode.CancellationToken
	): Promise<number> {
		let total = 0;
		for (const message of messages) {
			try {
				total += await model.countTokens(message, token);
			} catch (error) {
				this.log(`Token estimation failed for a message: ${this.toErrorMessage(error)}`);
				return total;
			}
		}
		return total;
	}

}

export function activate(context: vscode.ExtensionContext) {
	const tool = new OrchestrateSubagentsTool(context);
	context.subscriptions.push(vscode.lm.registerTool('orchestrateSubagents', tool));
}

export function deactivate() {
	// Nothing to clean up explicitly because disposables are registered on activation.
}

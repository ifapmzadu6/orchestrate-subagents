# Orchestrate Subagents

This VS Code extension adds a language model tool for GitHub Copilot Chat that can spin up multiple Copilot-like “subagents” in parallel. Each subagent receives its own system and user prompts, runs iterative turns (optionally calling any registered Copilot tools), and returns its findings to the parent chat without exhausting Copilot’s main conversation context.

## Highlights

- Launch up to three autonomous “subagents” in parallel, each with custom system/user prompts.
- Prompts are emitted in XML-like tags so subagents receive structured guidance.
- Subagents can call any Copilot Chat tool while keeping the parent chat UI quiet.
- The tool returns a concise JSON payload that contains only per-agent metadata and summaries.

## Requirements

- VS Code `1.93.0` or newer.
- GitHub Copilot Chat extension signed in and enabled for language model requests.

## Setup

```bash
npm install
npm run compile
```

During development, run the “Run Extension” launch configuration from VS Code or execute `code --extensionDevelopmentPath=.`.

## Using the Tool in Copilot Chat

1. Ensure the extension is activated (it registers on `onStartupFinished`).
2. In Copilot Chat, invoke the tool with the `#orchestrateSubagents` tag (the tool reference name) and supply structured input. Copilot’s chat UI accepts either natural language or explicit JSON. Example prompt:

   ```
   Use #orchestrateSubagents with:
   {
     "agents": [
       {
         "id": "search-code",
         "systemPrompt": "Focus on repository-wide code navigation. Prefer summarising file locations.",
         "userPrompt": "Identify modules related to OAuth authentication.",
         "maxTurns": 50
       },
       {
         "id": "doc-research",
         "systemPrompt": "Work as a documentation researcher. Extract only actionable findings.",
         "userPrompt": "Summarize any docs that mention OAuth configuration.",
         "maxTurns": 50
       }
     ]
   }
   ```

   (You can specify up to three agents per invocation; each agent can run up to 100 turns, with a default of 50.)

3. Copilot will run the tool, stream each subagent’s progress, and receive a JSON summary:

   ```json
   {
     "subagents": [
       {
         "id": "search-code",
         "systemPrompt": "Focus on repository-wide code navigation. Prefer summarising file locations.",
         "userPrompt": "Identify modules related to OAuth authentication.",
         "maxTurns": 50,
         "turnsTaken": 3,
         "toolCalls": 3,
         "summary": "Summarized findings here…"
       }
     ]
   }
   ```

   Each subagent entry preserves its prompts, turn/tool counts, and only the final summary text produced by the orchestrator.

### Output Shape

The tool response is compact JSON:

```json
{
  "subagents": [
    {
      "id": "string",
      "systemPrompt": "string",
      "userPrompt": "string",
      "maxTurns": 50,
      "turnsTaken": 3,
      "toolCalls": 2,
      "summary": "final response text"
    }
  ]
}
```

Detailed transcripts and raw tool payloads are intentionally omitted to keep the output easy to consume.

### Input Schema Summary

| Field | Type | Description |
| --- | --- | --- |
| `agents` | array (required, max 3) | List of subagent descriptors. |
| `agents[].id` | string | Identifier used in logs and summaries. |
| `agents[].systemPrompt` | string | System instructions the subagent must follow. |
| `agents[].userPrompt` | string | Initial user-facing task. |
| `agents[].maxTurns` | integer (1–100, default 50) | Limits iterative turns. |
| *(fixed)* | — | The orchestrator always uses the Copilot `gpt-5-mini` model. |

## How It Works

- Prompts are rendered as `<orchestrateSubagent>...</orchestrateSubagent>` XML blocks so instructions stay structured.
- The orchestrator always selects the Copilot `gpt-5-mini` chat model.
- Each subagent runs iteratively, calling Copilot tools as needed while suppressing additional UI in the parent chat.
- Only the final assistant text is retained; summaries are merged into the JSON payload shown above.

## Known Limitations & Next Steps

- The official Copilot Chat agent logic is not bundled here; instead, the extension relies on the public `vscode.lm` APIs to approximate the iterative flow. Copying more of GitHub’s implementation is possible by importing their open-source packages if licensing permits.
- Model selection is hard-coded to `gpt-5-mini`; if that model isn't available, the tool returns an error.
- Tool fan-out errors are surfaced in the aggregated response but are not yet streamed incrementally.
- Consider persisting transcripts or telemetry, and wiring commands/TreeViews if you need richer monitoring tooling.

Pull requests and ideas are welcome!

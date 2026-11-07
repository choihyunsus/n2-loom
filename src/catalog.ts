// Discover complete schemas on demand while keeping the selected prompt small enough for local models.
import type { Hecaton, ToolView, ToolResult } from 'n2-hecaton';
import type { ModelTool } from 'n2-gumiho';
import { objectValue } from './model-validation';
import { textValue, plainJson } from './values';
export const DISCOVERY: ModelTool = {
  name: 'loom_discover',
  description:
    'Find registered tools and their input schemas by task or exact name. This operation only reads the tool catalog.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1, maxLength: 4096 } },
    required: ['query'],
    additionalProperties: false,
  },
};
export class DialogueCatalog {
  readonly tools: Map<string, ToolView>;
  private readonly budget: number;
  constructor(
    private readonly hecaton: Hecaton,
    contextBytes: number,
  ) {
    this.tools = new Map(hecaton.list().map((tool) => [tool.name, tool]));
    if (this.tools.has(DISCOVERY.name)) throw new Error('The loom_discover tool name is reserved');
    this.budget = Math.min(65536, Math.floor(contextBytes / 3));
  }
  select(query: string, previous: string[] = []): string[] {
    const names = [...this.hecaton.route(query, 8).matches.map((match) => match.name), ...previous];
    const selected: string[] = [];
    let bytes = Buffer.byteLength(JSON.stringify(DISCOVERY));
    for (const name of new Set(names)) {
      const tool = this.tools.get(name);
      if (!tool || selected.length >= 8) continue;
      const size = Buffer.byteLength(JSON.stringify(modelTool(tool)));
      if (bytes + size > this.budget) continue;
      bytes += size;
      selected.push(name);
    }
    return selected;
  }
  modelTools(names: string[], mode: 'chat' | 'agent'): ModelTool[] {
    if (mode === 'chat') return [];
    return [
      DISCOVERY,
      ...names.map((name) => {
        const tool = this.tools.get(name);
        if (!tool) throw new Error('Selected tool is no longer registered');
        return modelTool(tool);
      }),
    ];
  }
  discover(args: unknown, previous: string[]): { result: ToolResult; selected: string[] } {
    const input = objectValue(plainJson(args));
    if (Object.keys(input).some((key) => key !== 'query'))
      throw new Error('Unknown discovery argument');
    const query = textValue(input.query, 'tool query', 4096);
    if (!query.trim()) throw new Error('A tool search query is required');
    const selected = this.select(query, previous);
    const cards = selected.map((name) => modelTool(this.tools.get(name)!));
    return {
      selected,
      result: {
        success: true,
        output: JSON.stringify({
          tools: cards,
          registeredCount: this.tools.size,
          schemaBudgetBytes: this.budget,
        }),
      },
    };
  }
}
function modelTool(tool: ToolView): ModelTool {
  return { name: tool.name, description: tool.description, parameters: tool.inputSchema };
}

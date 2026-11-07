// Configure one local provider and an explicit read-only tool for CLI or MCP use.
const { ollamaChat } = require('../dist/library');
const model = process.env.N2_LOOM_MODEL;
if (!model) throw new Error('Set N2_LOOM_MODEL to a model installed in your Ollama server');
module.exports = {
  limits: { contextBytes: 3072, maxOutputTokens: 256 },
  provider: ollamaChat({ id: 'local', model, think: false, contextLength: 4096 }),
  tools: [
    {
      name: 'word_count',
      version: '1',
      description: 'Count whitespace-separated words in the provided text',
      readOnly: true,
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 4096 } },
        required: ['text'],
        additionalProperties: false,
      },
      execute(args) {
        const count = args.text.trim() ? args.text.trim().split(/\s+/u).length : 0;
        return { success: true, output: String(count), data: { count } };
      },
    },
  ],
};

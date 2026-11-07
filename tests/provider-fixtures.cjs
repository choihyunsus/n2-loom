// Deterministic wire records exercise each official provider protocol without paid model calls.
const factories = {
  responses: require('../dist/provider-openai').openAIResponses,
  messages: require('../dist/provider-anthropic').anthropicMessages,
  interactions: require('../dist/provider-gemini').geminiInteractions,
  chat: require('../dist/provider-chat').openAICompatible,
  ollama: require('../dist/provider-ollama').ollamaChat,
};
function fixture(kind, text = '한글😀', tool = false, stop = 'complete') {
  const fragments = Array.from(text),
    args = JSON.stringify({ text: '한글😀' });
  if (kind === 'responses') {
    const output = [
      { type: 'reasoning', id: 'reasoning', summary: [], encrypted_content: 'opaque-fixture' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    ];
    if (tool)
      output.push({ type: 'function_call', call_id: 'call_1', name: 'echo', arguments: args });
    const status = stop === 'incomplete' ? 'incomplete' : 'completed';
    return [
      ...fragments.map((delta) => ({
        type: 'response.output_text.delta',
        output_index: 1,
        content_index: 0,
        delta,
      })),
      {
        type: `response.${status}`,
        response: {
          status,
          model: 'fixture',
          output,
          usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 3 } },
        },
      },
    ];
  }
  if (kind === 'messages') {
    const result = [
      {
        type: 'message_start',
        message: {
          type: 'message',
          role: 'assistant',
          model: 'fixture',
          content: [],
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'private-fixture' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'opaque-fixture' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      ...fragments.map((text) => ({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text },
      })),
      { type: 'content_block_stop', index: 1 },
    ];
    if (tool)
      result.push(
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'call_1', name: 'echo', input: {} },
        },
        ...[args.slice(0, 9), args.slice(9)].map((partial_json) => ({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json },
        })),
        { type: 'content_block_stop', index: 2 },
      );
    result.push(
      {
        type: 'message_delta',
        delta: {
          stop_reason:
            stop === 'incomplete'
              ? 'max_tokens'
              : stop === 'refused'
                ? 'refusal'
                : tool
                  ? 'tool_use'
                  : 'end_turn',
        },
        usage: { output_tokens: 5, input_tokens: null },
      },
      { type: 'message_stop' },
    );
    return result;
  }
  if (kind === 'interactions') {
    const result = [
      {
        event_type: 'interaction.created',
        interaction: { id: 'interaction', status: 'in_progress', model: 'fixture' },
      },
      { event_type: 'step.start', index: 0, step: { type: 'thought' } },
      {
        event_type: 'step.delta',
        index: 0,
        delta: { type: 'thought_signature', signature: 'opaque-fixture' },
      },
      {
        event_type: 'step.delta',
        index: 0,
        delta: { type: 'thought_summary', content: { type: 'text', text: 'private-fixture' } },
      },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'step.start', index: 1, step: { type: 'model_output' } },
      ...fragments.map((text) => ({
        event_type: 'step.delta',
        index: 1,
        delta: { type: 'text', text },
      })),
      { event_type: 'step.stop', index: 1 },
    ];
    if (tool)
      result.push(
        {
          event_type: 'step.start',
          index: 2,
          step: { type: 'function_call', id: 'call_1', name: 'echo', arguments: {} },
        },
        ...[args.slice(0, 9), args.slice(9)].map((arguments) => ({
          event_type: 'step.delta',
          index: 2,
          delta: { type: 'arguments_delta', arguments },
        })),
        { event_type: 'step.stop', index: 2 },
      );
    result.push({
      event_type: 'interaction.completed',
      interaction: {
        status: stop === 'incomplete' ? 'incomplete' : tool ? 'requires_action' : 'completed',
        usage: {
          total_input_tokens: 10,
          total_output_tokens: 5,
          total_thought_tokens: 2,
          total_cached_tokens: 3,
        },
      },
    });
    return result;
  }
  if (kind === 'chat') {
    const chunk = (delta) => ({
      model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: null }],
    });
    const result = [
      chunk({ role: 'assistant', reasoning_content: 'private-fixture' }),
      ...fragments.map((content) => chunk({ content })),
    ];
    if (tool)
      result.push(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'echo', arguments: args.slice(0, 9) },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(9) } }] }),
      );
    result.push(
      {
        model: 'fixture',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason:
              stop === 'incomplete'
                ? 'length'
                : stop === 'refused'
                  ? 'content_filter'
                  : tool
                    ? 'tool_calls'
                    : 'stop',
          },
        ],
      },
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 3 },
        },
      },
      '[DONE]',
    );
    return result;
  }
  const chunk = (message) => ({
    model: 'fixture',
    message: { role: 'assistant', content: '', ...message },
    done: false,
  });
  const result = [
    chunk({ thinking: 'private-fixture' }),
    ...fragments.map((content) => chunk({ content })),
  ];
  if (tool)
    result.push(
      chunk({ tool_calls: [{ function: { name: 'echo', arguments: JSON.parse(args) } }] }),
    );
  result.push({
    ...chunk({}),
    done: true,
    done_reason: stop === 'incomplete' ? 'length' : 'stop',
    prompt_eval_count: 10,
    eval_count: 5,
    prompt_eval_cached_count: 3,
  });
  return result;
}
function encode(kind, events) {
  return events
    .map((event) => {
      const text = typeof event === 'string' ? event : JSON.stringify(event);
      return kind === 'ollama' ? text + '\n' : 'data: ' + text + '\n\n';
    })
    .join('');
}
module.exports = { factories, fixture, encode };

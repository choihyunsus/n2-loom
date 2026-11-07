// Assemble Interactions steps from the current documented step-based SSE protocol.
import { ProviderError } from 'n2-gumiho';
import { arrayValue, objectValue, type JsonObject } from './model-validation';
import { textValue } from './values';
import { StreamBlocks, appendText } from './stream-blocks';
import type { StreamDecoder, StreamStep } from './stream-types';

export class InteractionsDecoder implements StreamDecoder {
  private interaction: JsonObject = {};
  private readonly blocks = new StreamBlocks();
  private textBlocks = 0;
  accept(event: JsonObject): StreamStep {
    const type = textValue(event.event_type ?? event.type, 'stream event type', 256);
    if (
      event.event_type !== undefined &&
      event.type !== undefined &&
      event.type !== event.event_type
    )
      throw new Error('Conflicting stream event types');
    if (type === 'error' || type === 'interaction.failed')
      throw new ProviderError('upstream_stream_error');
    if (type === 'interaction.created' || type === 'interaction.in_progress') {
      if (event.interaction !== undefined)
        this.interaction = { ...this.interaction, ...objectValue(event.interaction) };
      return {};
    }
    if (type === 'step.start') return this.start(event);
    if (type === 'step.delta') return this.delta(event);
    if (type === 'step.stop') {
      this.blocks.stop(event.index, 'arguments');
      return {};
    }
    if (
      [
        'interaction.completed',
        'interaction.requires_action',
        'interaction.cancelled',
        'interaction.incomplete',
      ].includes(type)
    ) {
      const completed: JsonObject = {
        ...this.interaction,
        ...objectValue(event.interaction),
        steps: this.blocks.complete(),
      };
      if (type === 'interaction.requires_action' && completed.status !== 'requires_action')
        throw new Error('Conflicting interaction completion status');
      return { completed };
    }
    return {};
  }
  private start(event: JsonObject): StreamStep {
    const step = this.blocks.start(event.index, event.step);
    if (!['thought', 'model_output', 'function_call'].includes(String(step.type)))
      throw new Error('Unsupported streamed interaction step');
    if (step.type !== 'model_output') return {};
    const parts = arrayValue(step.content ?? []);
    const text = parts
      .map((raw) => {
        const part = objectValue(raw);
        if (part.type !== 'text') throw new Error('Unsupported non-text streamed content');
        return textValue(part.text, 'initial output text', 131072);
      })
      .join('\n');
    step.content = [{ type: 'text', text }];
    const separator = this.textBlocks++ > 0 ? '\n' : '';
    return { delta: separator + text };
  }
  private delta(event: JsonObject): StreamStep {
    const step = this.blocks.current(event.index).value,
      delta = objectValue(event.delta);
    if (delta.type === 'text' && step.type === 'model_output')
      return { delta: appendText(objectValue(arrayValue(step.content)[0]), 'text', delta.text) };
    if (delta.type === 'arguments_delta' && step.type === 'function_call')
      this.blocks.arguments(event.index, delta.arguments);
    else if (delta.type === 'thought_signature' && step.type === 'thought')
      appendText(step, 'signature', delta.signature, 262144);
    else if (delta.type === 'thought_summary' && step.type === 'thought') {
      const content = objectValue(delta.content);
      if (content.type !== 'text') throw new Error('Unsupported thought summary content');
      step.summary = [...arrayValue(step.summary ?? [], 256), content];
    } else throw new Error('Unsupported delta for this interaction step');
    return {};
  }
}

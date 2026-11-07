// Stateful provider blocks preserve opaque signatures and complete JSON arguments before tool dispatch.
import { objectValue, arrayValue, type JsonObject } from './model-validation';
import { plainJson, textValue } from './values';
import type { JsonValue } from './types';

interface Block {
  value: JsonObject;
  arguments: string;
  receivedArguments: boolean;
  closed: boolean;
}
export class StreamBlocks {
  private readonly blocks = new Map<number, Block>();
  start(rawIndex: JsonValue | undefined, raw: JsonValue | undefined): JsonObject {
    const index = blockIndex(rawIndex);
    if (this.blocks.has(index)) throw new Error('Duplicate stream block');
    const value = objectValue(plainJson(raw, 524288, 32768, 32));
    this.blocks.set(index, { value, arguments: '', receivedArguments: false, closed: false });
    return value;
  }
  current(rawIndex: JsonValue | undefined): Block {
    const block = this.blocks.get(blockIndex(rawIndex));
    if (!block || block.closed) throw new Error('Stream block is absent or already closed');
    return block;
  }
  arguments(rawIndex: JsonValue | undefined, fragment: JsonValue | undefined): void {
    const block = this.current(rawIndex);
    block.arguments += textValue(fragment, 'tool argument delta');
    textValue(block.arguments, 'accumulated tool arguments');
    block.receivedArguments = true;
  }
  stop(rawIndex: JsonValue | undefined, argumentField: string): void {
    const block = this.current(rawIndex);
    if (block.receivedArguments)
      block.value[argumentField] = objectValue(plainJson(JSON.parse(block.arguments)));
    block.closed = true;
  }
  complete(): JsonObject[] {
    const result: JsonObject[] = [];
    for (let index = 0; index < this.blocks.size; index++) {
      const block = this.blocks.get(index);
      if (!block?.closed) throw new Error('Incomplete or noncontiguous provider blocks');
      result.push(block.value);
    }
    return arrayValue(plainJson(result, 524288, 32768, 32)) as JsonObject[];
  }
}
export function appendText(
  object: JsonObject,
  field: string,
  value: JsonValue | undefined,
  maximum = 131072,
): string {
  const delta = textValue(value, `${field} delta`, maximum);
  object[field] = textValue((object[field] ?? '') as string, field, maximum) + delta;
  textValue(object[field], `accumulated ${field}`, maximum);
  return delta;
}
export function blockIndex(value: JsonValue | undefined): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value >= 256)
    throw new Error('Invalid provider block index');
  return value;
}

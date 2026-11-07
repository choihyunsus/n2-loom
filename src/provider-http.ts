// Wire codecs share the bounded streaming transport and published provider option/error types.
export {
  credential as apiCredential,
  checkedEndpoint as providerEndpoint,
  streamTransport,
  abortable,
} from './stream-http';
export { ProviderError } from 'n2-gumiho';
export type { HttpProviderOptions } from 'n2-gumiho';

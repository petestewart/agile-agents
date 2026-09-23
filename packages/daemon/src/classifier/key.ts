/**
 * The classifier key set from Settings without a restart: the daemon's
 * `config.classifier` object is shared by reference with every key reader,
 * so a save writes `config.yaml` and then sets `api_key` on that object.
 * `status()` says where the key comes from, never the key.
 */

import type { ClassifierConfig, ClassifierKeyStatus } from '@agile-agents/shared';
import { TYPESAFE_API_KEY_ENV } from './jev';

export interface ClassifierKeyStore {
  setClassifierApiKey(key: string | undefined): Promise<void>;
}

export interface ClassifierKeyServiceOptions {
  /** The daemon's live `config.classifier`, mutated in place. */
  config: ClassifierConfig;
  store: ClassifierKeyStore;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export class ClassifierKeyService {
  private readonly env: Record<string, string | undefined>;

  constructor(private readonly options: ClassifierKeyServiceOptions) {
    this.env = options.env ?? process.env;
  }

  status(): ClassifierKeyStatus {
    const fromEnv = (this.env[TYPESAFE_API_KEY_ENV] ?? '') !== '';
    const fromConfig = this.options.config.api_key !== undefined;
    const source = fromConfig ? 'config' : fromEnv ? 'environment' : 'none';
    return {
      source,
      loaded: source !== 'none' && this.options.config.provider !== 'off',
      provider: this.options.config.provider,
      environment_also: fromConfig && fromEnv,
    };
  }

  /** Writes `classifier.api_key` to `config.yaml`, then makes it live. */
  async set(key: string): Promise<ClassifierKeyStatus> {
    await this.options.store.setClassifierApiKey(key);
    this.options.config.api_key = key;
    return this.status();
  }

  /** Deletes `classifier.api_key` from `config.yaml`; an env key, if any, still applies. */
  async remove(): Promise<ClassifierKeyStatus> {
    await this.options.store.setClassifierApiKey(undefined);
    Reflect.deleteProperty(this.options.config, 'api_key');
    return this.status();
  }
}

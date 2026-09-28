import { describe, expect, test } from 'bun:test';
import { modelFromSessionState } from './session';

describe('T467a: the model a session reports', () => {
  test('from configOptions (the Claude bridge), a model record, or ACP models.currentModelId', () => {
    expect(
      modelFromSessionState({ configOptions: [{ id: 'model', currentValue: 'claude-opus-5-5' }] }),
    ).toBe('claude-opus-5-5');
    expect(modelFromSessionState({ configOptions: { model: 'gpt-x' } })).toBe('gpt-x');
    expect(
      modelFromSessionState({
        configOptions: null,
        models: { currentModelId: 'gemini-pro', availableModels: [{ modelId: 'gemini-pro' }] },
      }),
    ).toBe('gemini-pro');
    expect(modelFromSessionState({ configOptions: null, models: null })).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { AppError } from '../../shared/errors.js';
import { requireChangeReason } from './platform-units.routes.js';

describe('platform unit change reason', () => {
  it.each([undefined, null, '', '  ', 'abcd'])('rejects an invalid reason before persistence', (value) => {
    try {
      requireChangeReason(value);
      throw new Error('expected validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        statusCode: 422,
        code: 'VALIDATION_ERROR',
        fieldErrors: { change_reason: 'Informe o motivo da alteração com pelo menos 5 caracteres.' },
      });
    }
  });

  it('normalizes a valid reason', () => {
    expect(requireChangeReason('  Ajuste cadastral  ')).toBe('Ajuste cadastral');
  });
});

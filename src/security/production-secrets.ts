import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

/** Fix only missing metrics credentials and a duplicated access signing key.
 * Never rotate encryption, tracking, VAPID or provider keys automatically. */
export function prepareProductionSecrets(contents: string): { contents: string; changed: string[] } {
  const values = parseEnv(contents);
  const changed: string[] = [];
  const secrets = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'TRACKING_TOKEN_PEPPER', 'MESSAGE_PAYLOAD_SECRET'];
  const managed = [...secrets, 'JWT_ACCESS_SECRET_PREVIOUS', 'METRICS_BEARER_TOKEN'];
  for (const key of managed) {
    const assignments = contents.match(new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=`, 'gm')) ?? [];
    if (assignments.length > 1) throw new Error('Ambiguous assignments');
  }
  // A missing data key may mean existing data relies on a fallback. Do not invent one.
  if (secrets.some(key => !values[key] || values[key].length < 32)) throw new Error('Manual review required');
  const preserved = secrets.slice(1).map(key => values[key]);
  if (new Set(preserved).size !== preserved.length) throw new Error('Protected keys need manual review');
  const generate = () => {
    let value: string;
    do { value = randomBytes(48).toString('base64url'); } while (Object.values(values).includes(value));
    return value;
  };
  const set = (key: string, value: string) => {
    const expression = new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=([^\\r\\n]*)`, 'm');
    const assignment = contents.match(expression);
    if (assignment) {
      // Do not partially replace quoted multiline values.
      const parsedLine = parseEnv(assignment[0])[key];
      if (parsedLine !== values[key]) throw new Error('Multiline assignment');
      contents = contents.replace(expression, () => `${key}=${value}`);
    } else {
      const newline = contents.includes('\r\n') ? '\r\n' : '\n';
      contents += `${contents.endsWith('\n') ? '' : newline}${key}=${value}${newline}`;
    }
    values[key] = value;
    changed.push(key);
  };
  if (preserved.includes(values.JWT_ACCESS_SECRET)) {
    if (values.JWT_ACCESS_SECRET_PREVIOUS && values.JWT_ACCESS_SECRET_PREVIOUS !== values.JWT_ACCESS_SECRET) {
      throw new Error('Existing rotation must finish first');
    }
    set('JWT_ACCESS_SECRET_PREVIOUS', values.JWT_ACCESS_SECRET!);
    set('JWT_ACCESS_SECRET', generate());
  }
  if (!values.METRICS_BEARER_TOKEN) set('METRICS_BEARER_TOKEN', generate());
  else if (values.METRICS_BEARER_TOKEN.length < 32 || secrets.some(key => values[key] === values.METRICS_BEARER_TOKEN)) {
    throw new Error('Existing metrics credential needs manual rotation');
  }
  return { contents, changed };
}

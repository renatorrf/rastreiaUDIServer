import {describe,expect,it,vi,afterEach} from 'vitest';
import type {PoolClient} from 'pg';
import {createIdentityEmail} from './identity-email.js';
import {createIdentityAction} from '../../modules/auth/identity.service.js';
import {parseAppEnv} from '../../config/env.js';
import {decryptPayload} from '../../shared/encrypted-payload.js';
import type {EmailPayload} from './email.service.js';

const expiresAt=new Date('2026-10-28T18:00:00Z');
const actionUrl='https://app.example.test/redefinir-senha#test-only-token';
afterEach(()=>vi.useRealTimers());
describe('RastreiaAPP identity email templates',()=>{
  it.each([
    ['INVITE',true,'Criar senha e aceitar convite','24 horas'],
    ['INVITE',false,'Aceitar convite','24 horas'],
    ['VERIFY_EMAIL',false,'Confirmar meu e-mail','24 horas'],
    ['RESET_PASSWORD',false,'Redefinir minha senha','1 hora'],
  ] as const)('renders %s (%s) with HTML and plain text', (kind,requiresPassword,label,ttl)=>{
    const result=createIdentityEmail({to:'recipient@example.test',kind,requiresPassword,actionUrl,expiresAt});
    expect(result.to).toBe('recipient@example.test');expect(result.subject).toContain('RastreiaAPP');
    for(const body of [result.html!,result.text]){
      expect(body).toContain(label);expect(body).toContain(ttl);expect(body).toContain('15:00');
      expect(body).toContain(actionUrl);expect(body).toContain('uso único');
    }
    expect(result.html).toContain('lang="pt-BR"');expect(result.html).toContain('role="presentation"');
    expect(result.html).toContain('#35d07f');expect(result.html).toContain('#111418');
    expect(result.html).not.toMatch(/<script|<form|<iframe|<img|https?:\/\/fonts|javascript:/i);
  });
  it('keeps existing-account invitations distinct from new password invitations',()=>{
    const result=createIdentityEmail({to:'r@example.test',kind:'INVITE',actionUrl,expiresAt});
    expect(result.text).toContain('senha da sua conta');expect(result.text).not.toContain('crie sua senha');
  });
  it('escapes HTML-sensitive URL characters while retaining the usable plain text URL',()=>{
    const url='https://app.example.test/convite?source=email&label="test"#safe-token';
    const result=createIdentityEmail({to:'r@example.test',kind:'INVITE',actionUrl:url,expiresAt});
    expect(result.html).toContain('&amp;label=');expect(result.html).not.toContain('label="test"');
    expect(result.text).toContain(new URL(url).href);
  });
  it.each(['javascript:alert(1)','data:text/html,unsafe','https://user:secret@example.test/reset'])('rejects unsafe action URL %s',url=>{
    expect(()=>createIdentityEmail({to:'r@example.test',kind:'RESET_PASSWORD',actionUrl:url,expiresAt})).toThrow('INVALID_EMAIL_ACTION_URL');
  });
  it.each(['INVITE','VERIFY_EMAIL','RESET_PASSWORD'] as const)('queues encrypted HTML and retains fragment-only token for %s',async kind=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-28T15:00:00Z'));
    const env=parseAppEnv({NODE_ENV:'test',DATABASE_URL:'postgresql://unused:unused@localhost/unused',
      JWT_ACCESS_SECRET:'a'.repeat(40),JWT_REFRESH_SECRET:'b'.repeat(40),TRACKING_TOKEN_PEPPER:'c'.repeat(40),
      MESSAGE_PAYLOAD_SECRET:'d'.repeat(40),EMAIL_ACTION_BASE_URL:'https://app.example.test'});
    const query=vi.fn(async(_sql:string,_values?:unknown[])=>({rows:[],rowCount:0}));
    const client={query} as unknown as PoolClient;
    const action=await createIdentityAction(client,env,{userId:'11111111-1111-4111-8111-111111111111',email:'r@example.test',kind,requiresPassword:true});
    const values=query.mock.calls.find(([sql])=>sql.includes('INSERT INTO email_jobs'))![1]!;
    const payload=decryptPayload<EmailPayload>(String(values[1]),env.MESSAGE_PAYLOAD_SECRET);
    expect(payload.html).toContain('RastreiaAPP');expect(payload.html).toContain(payload.subject);
    const link=payload.text.match(/https:\/\/\S+/)![0];const url=new URL(link);
    expect(url.hash).toMatch(/^#[A-Za-z0-9_-]{43}$/);expect(url.search).toBe('');
    expect(url.pathname).toBe(kind==='INVITE'?'/convite':kind==='VERIFY_EMAIL'?'/verificar-email':'/redefinir-senha');
    expect(action.expiresAt.getTime()-Date.now()).toBe((kind==='RESET_PASSWORD'?3600:86400)*1000);
    expect(JSON.stringify(query.mock.calls)).not.toContain(url.hash.slice(1));
    expect(String(values[1])).not.toContain('r@example.test');
  });
});

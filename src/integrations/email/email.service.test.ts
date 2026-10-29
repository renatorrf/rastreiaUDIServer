import {describe,expect,it,vi,beforeEach} from 'vitest';
import nodemailer from 'nodemailer';
import {processEmailBatch,type EmailPayload} from './email.service.js';
import {encryptPayload} from '../../shared/encrypted-payload.js';
import {parseAppEnv} from '../../config/env.js';
import type {Database} from '../../database/pool.js';

vi.mock('nodemailer',()=>({default:{createTransport:vi.fn()}}));
const env=parseAppEnv({NODE_ENV:'test',DATABASE_URL:'postgresql://unused:unused@localhost/unused',
  JWT_ACCESS_SECRET:'a'.repeat(40),JWT_REFRESH_SECRET:'b'.repeat(40),TRACKING_TOKEN_PEPPER:'c'.repeat(40),
  MESSAGE_PAYLOAD_SECRET:'d'.repeat(40),SMTP_HOST:'smtp.example.test',SMTP_FROM:'RastreiaAPP <no-reply@example.test>',
  EMAIL_ACTION_BASE_URL:'https://app.example.test'});
beforeEach(()=>vi.resetAllMocks());
describe('email queue transport compatibility',()=>{
  it.each([false,true])('sends encrypted queued payload with HTML=%s without real SMTP',async html=>{
    const payload:EmailPayload={to:'recipient@example.test',subject:'RastreiaAPP',text:'Plain text',...(html?{html:'<p>RastreiaAPP</p>'}:{})};
    const sendMail=vi.fn().mockResolvedValue({accepted:['recipient@example.test']});
    vi.mocked(nodemailer.createTransport).mockReturnValue({sendMail} as unknown as ReturnType<typeof nodemailer.createTransport>);
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('RETURNING id, encrypted_payload, attempts')
      ?[{id:'test-job',encrypted_payload:encryptPayload(payload,env.MESSAGE_PAYLOAD_SECRET),attempts:1}]:[],rowCount:1}));
    const client={query,release:vi.fn()};
    const database={query:vi.fn(async()=>({rows:[],rowCount:1})),connect:vi.fn(async()=>client)} as unknown as Database;
    expect(await processEmailBatch(database,env,1)).toEqual({sent:1,configured:true});
    expect(sendMail).toHaveBeenCalledWith({...payload,from:env.SMTP_FROM,messageId:'<test-job@rastreia.app>'});
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({disableFileAccess:true,disableUrlAccess:true,requireTLS:true,logger:false,debug:false}));
  });
});

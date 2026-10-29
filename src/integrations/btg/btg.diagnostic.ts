// Diagnostics contain only local enum values, never provider strings, headers or identifiers.
const oauthErrors = ['invalid_client','invalid_grant','invalid_scope','unauthorized_client',
  'unsupported_grant_type','invalid_request','access_denied','server_error','temporarily_unavailable'] as const;
const fields = ['error','code','errorCode','error_description','message','description','detail','title','errors'] as const;
const hintPatterns = {
  CLIENT_AUTHENTICATION: /\bclient[ _-]?(?:id|secret|authentication|credentials)\b/i,
  AUTHORIZATION_CODE: /\b(?:authorization[ _-]code|invalid[ _-]grant|expired[ _-]code)\b/i,
  REDIRECT_URI: /\bredirect[ _-]?(?:uri|url)\b/i,
  PKCE: /\b(?:pkce|code[ _-]verifier|code[ _-]challenge)\b/i,
  GRANT_TYPE: /\bgrant[ _-]type\b/i,
  SCOPE: /\bscopes?\b/i,
} as const;
type ErrorField = typeof fields[number];
type Hint = keyof typeof hintPatterns;
// Recognize a small set of explicit statements, not arbitrary nearby keywords.
// These are provider-reported hints, never proof of the underlying cause.
const authorizationCode = '(?:authorization code|auth code|codigo de autorizacao)';
const statementStart = '^(?:(?:the|o|provided|received|supplied) )?';
const codeStatement = (predicate:string) => new RegExp(
  `${statementStart}(?:${predicate} ${authorizationCode}|${authorizationCode} (?:(?:is|was|has|esta|foi) )?${predicate})(?:$|[ ,])`,
);
const codeRejectionPatterns = {
  INVALID_OR_EXPIRED: codeStatement('(?:invalid or (?:has )?expired|expired or invalid|invalido ou expirado|expirado ou invalido)'),
  EXPIRED: codeStatement('(?:expired|expirado|expirou)'),
  ALREADY_USED: codeStatement('(?:already (?:been )?(?:used|consumed|redeemed)|ja (?:foi )?(?:utilizado|usado|consumido))'),
  NOT_FOUND: codeStatement('(?:not found|does not exist|nao encontrado|nao existe)'),
  INVALID: codeStatement('(?:invalid|invalido)'),
  CLIENT_MISMATCH: new RegExp(`${statementStart}${authorizationCode} (?:was |is )?(?:issued (?:to|for) (?:a )?different client|belongs to (?:a )?different client|does not belong to (?:this|the) client)(?:$|[ ,])`),
  REDIRECT_URI_MISMATCH: /^(?:the )?redirect (?:uri|url) (?:(?:does not|doesn't) match|mismatch|is mismatched)(?:$|[ ,])/,
  PKCE_MISMATCH: /^(?:the )?(?:pkce|code verifier|code challenge) (?:verification failed|validation failed|mismatch|is invalid|does not match)(?:$|[ ,])/,
} as const;
type CodeRejectionHint = keyof typeof codeRejectionPatterns;
const codeRejectionKeys = Object.keys(codeRejectionPatterns) as CodeRejectionHint[];

function inspectCodeRejection(value:string,hints:Set<CodeRejectionHint>){
  const normalized=value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[_-]/g,' ');
  for(const part of normalized.split(/[.!?;\n:]/)){
    const statement=part.trim().replace(/\s+/g,' ');
    if(codeRejectionPatterns.INVALID_OR_EXPIRED.test(statement)){
      hints.add('INVALID_OR_EXPIRED');continue;
    }
    for(const hint of codeRejectionKeys)if(codeRejectionPatterns[hint].test(statement))hints.add(hint);
  }
}
export interface BtgRejectionDiagnostic {
  oauthError:typeof oauthErrors[number]|'unrecognized';
  responseMedia:'json'|'html'|'form'|'text'|'other'|'missing';
  bodyFormat:'json_object'|'json_array'|'json_scalar'|'html'|'form'|'text'|'empty'|'unreadable'|'too_large';
  errorFields?:ErrorField[];
  reasonHints?:Hint[];
  codeRejectionHints?:CodeRejectionHint[];
}
const maxBytes = 16_384;
function mediaType(response:Response):BtgRejectionDiagnostic['responseMedia'] {
  const type=response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if(!type)return 'missing';
  if(type==='application/json'||type.endsWith('+json'))return 'json';
  if(type==='text/html')return 'html';
  if(type==='application/x-www-form-urlencoded')return 'form';
  return type==='text/plain'?'text':'other';
}
async function readLimited(response:Response):Promise<{text:string}|{failure:'unreadable'|'too_large'}>{
  if(!response.body)return {text:''};
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      const {value,done}=await reader.read();if(done)break;
      if(!(value instanceof Uint8Array)){void reader.cancel().catch(()=>{});return {failure:'unreadable'};}
      size+=value.byteLength;
      if(size>maxBytes){void reader.cancel().catch(()=>{});return {failure:'too_large'};}
      chunks.push(value);
    }
    return {text:Buffer.concat(chunks).toString('utf8')};
  }catch{return {failure:'unreadable'};}
  finally{reader.releaseLock();}
}
export async function rejectionDiagnostic(response:Response):Promise<BtgRejectionDiagnostic>{
  const base={oauthError:'unrecognized' as const,responseMedia:mediaType(response)};
  const result=await readLimited(response);
  if('failure' in result)return {...base,bodyFormat:result.failure};
  const text=result.text.trim();
  if(!text)return {...base,bodyFormat:'empty'};
  let body:unknown;
  let bodyFormat:BtgRejectionDiagnostic['bodyFormat'];
  try{
    body=JSON.parse(text) as unknown;
    bodyFormat=Array.isArray(body)?'json_array':body!==null&&typeof body==='object'?'json_object':'json_scalar';
  }catch{
    if(base.responseMedia==='html'||/^\s*(?:<!doctype\s+html|<html)\b/i.test(text))return {...base,bodyFormat:'html'};
    if(base.responseMedia==='form'){
      const params=new URLSearchParams(text);
      body=Object.fromEntries(fields.filter(field=>params.has(field)).map(field=>[field,params.get(field)]));
      bodyFormat='form';
    }else {body={message:text};bodyFormat='text';}
  }
  const seen=new Set<ErrorField>(),hints=new Set<Hint>(),codeHints=new Set<CodeRejectionHint>();
  let oauthError:BtgRejectionDiagnostic['oauthError']='unrecognized';
  function inspect(value:unknown,depth:number){
    if(depth>4)return;
    if(typeof value==='string'){
      const normalized=value.trim().toLowerCase().replace(/[ -]/g,'_');
      const known=oauthErrors.find(code=>code===normalized);
      if(known&&oauthError==='unrecognized')oauthError=known;
      for(const hint of Object.keys(hintPatterns) as Hint[])if(hintPatterns[hint].test(value))hints.add(hint);
      inspectCodeRejection(value,codeHints);
    }else if(Array.isArray(value)){
      for(const item of value.slice(0,8))inspect(item,depth+1);
    }else if(value&&typeof value==='object'){
      for(const field of fields)if(Object.hasOwn(value,field)){
        seen.add(field);inspect((value as Record<string,unknown>)[field],depth+1);
      }
    }
  }
  // Root scalar values may be tokens or identifiers; only inspect known error fields.
  if(body&&typeof body==='object')inspect(body,0);
  return {...base,bodyFormat,oauthError,errorFields:fields.filter(field=>seen.has(field)),
    reasonHints:(Object.keys(hintPatterns) as Hint[]).filter(hint=>hints.has(hint)),
    ...(codeHints.size?{codeRejectionHints:codeRejectionKeys.filter(hint=>codeHints.has(hint))}:{})};
}

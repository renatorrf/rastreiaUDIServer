import {describe,expect,it,vi} from 'vitest';
import {rejectionDiagnostic} from './btg.diagnostic.js';

describe('BTG bounded rejection diagnostics',()=>{
  it.each([
    {error:'invalid_client'}, {error:{code:'INVALID_CLIENT'}}, {errorCode:'invalid-client'},
    {code:'invalid client'}, {errors:[{code:'invalid_client'}]},
    {error:{errors:[{error:'invalid_client'}]}}, [{error:'invalid_client'}],
  ])('recognizes a known OAuth code in supported structures: %j',async body=>{
    expect(await rejectionDiagnostic(new Response(JSON.stringify(body),{status:400}))).toMatchObject({oauthError:'invalid_client'});
  });
  it('recognizes form errors and plain known errors without copying strings',async()=>{
    expect(await rejectionDiagnostic(new Response('error=invalid_grant&code=private-code',{headers:{'content-type':'application/x-www-form-urlencoded'}}))).toMatchObject({bodyFormat:'form',oauthError:'invalid_grant'});
    expect(await rejectionDiagnostic(new Response('invalid_client'))).toMatchObject({bodyFormat:'text',oauthError:'invalid_client'});
  });
  it('reports only topic hints, not a speculative cause or provider message',async()=>{
    const result=await rejectionDiagnostic(new Response(JSON.stringify({error:{code:1234,message:'Check client_secret, redirect_uri, authorization code and code_verifier. Private values here.'}}),{headers:{'content-type':'application/problem+json'}}));
    expect(result).toEqual({responseMedia:'json',bodyFormat:'json_object',oauthError:'unrecognized',errorFields:['error','code','message'],reasonHints:['CLIENT_AUTHENTICATION','AUTHORIZATION_CODE','REDIRECT_URI','PKCE']});
    expect(JSON.stringify(result)).not.toContain('Private');
  });
  it.each([
    ['<html>private-token</html>','text/html','html','html'],
    ['<!DOCTYPE html><html>private-token</html>','text/plain','text','html'],
    ['bad json {private-token','application/json','json','text'],
    ['"private-token"','application/json','json','json_scalar'],
    ['null','application/json','json','json_scalar'],
    ['','application/json','json','empty'],
    ['{}','application/octet-stream; private=secret','other','json_object'],
  ])('classifies body and media without logging content (%s)',async(body,contentType,responseMedia,bodyFormat)=>{
    const result=await rejectionDiagnostic(new Response(body,{headers:{'content-type':contentType}}));
    expect(result).toMatchObject({responseMedia,bodyFormat,oauthError:'unrecognized'});
    expect(JSON.stringify(result)).not.toMatch(/private|secret/);
  });
  it('never emits dynamic keys, unknown codes, numeric identifiers, URLs, headers or token values',async()=>{
    const body={error:{code:'UNKNOWN_PRIVATE_CODE',message:'Private token abc123',secretKey:'private-secret',errorCode:34999999999},access_token:'private-access',refresh_token:'private-refresh',privateKey:'private-value'};
    const result=await rejectionDiagnostic(new Response(JSON.stringify(body),{headers:{'set-cookie':'private-cookie','x-request-id':'private-id','content-type':'application/json'}}));
    expect(result).toEqual({oauthError:'unrecognized',bodyFormat:'json_object',responseMedia:'json',errorFields:['error','code','errorCode','message'],reasonHints:[]});
    expect(JSON.stringify(result)).not.toMatch(/private|UNKNOWN|349999/);
  });
  it('does not inspect unknown nesting or token fields even when they contain OAuth words',async()=>{
    const result=await rejectionDiagnostic(new Response(JSON.stringify({access_token:'invalid_client',custom:{error:'invalid_grant'}})));
    expect(result.oauthError).toBe('unrecognized');expect(result.errorFields).toEqual([]);
  });
  it('limits error response size and cancels the reader',async()=>{
    const cancel=vi.fn();
    const response=new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode('x'.repeat(16385)));},cancel}));
    expect(await rejectionDiagnostic(response)).toMatchObject({bodyFormat:'too_large',oauthError:'unrecognized'});
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('limits array and nesting traversal',async()=>{
    for(const body of [
      {errors:[...Array.from({length:8},()=>({code:'unknown'})),{code:'invalid_client'}]},
      {error:{error:{error:{error:{code:'invalid_client'}}}}},
    ])expect((await rejectionDiagnostic(new Response(JSON.stringify(body)))).oauthError).toBe('unrecognized');
  });
  it('preserves rejection classification when the response stream fails',async()=>{
    const response=new Response(new ReadableStream({start(controller){controller.error(new Error('private-network-details'));}}));
    expect(await rejectionDiagnostic(response)).toEqual({responseMedia:'missing',bodyFormat:'unreadable',oauthError:'unrecognized'});
  });

  it.each([
    ['Authorization code has expired.','EXPIRED'],
    ['Expired authorization code','EXPIRED'],
    ['AUTHORIZATION_CODE_EXPIRED','EXPIRED'],
    ['O código de autorização está expirado.','EXPIRED'],
    ['Authorization code has already been used.','ALREADY_USED'],
    ['Authorization code already redeemed','ALREADY_USED'],
    ['Código de autorização já foi utilizado','ALREADY_USED'],
    ['Authorization code not found','NOT_FOUND'],
    ['Authorization code does not exist','NOT_FOUND'],
    ['Código de autorização não encontrado','NOT_FOUND'],
    ['Invalid authorization code','INVALID'],
    ['Código de autorização inválido','INVALID'],
    ['Invalid or expired authorization code','INVALID_OR_EXPIRED'],
    ['Authorization code is invalid or has expired','INVALID_OR_EXPIRED'],
    ['Expired or invalid authorization code','INVALID_OR_EXPIRED'],
    ['Código de autorização inválido ou expirado','INVALID_OR_EXPIRED'],
    ['Authorization code was issued for a different client','CLIENT_MISMATCH'],
    ['Authorization code does not belong to this client','CLIENT_MISMATCH'],
    ['Redirect URI does not match the registered callback','REDIRECT_URI_MISMATCH'],
    ['Code verifier does not match the code challenge','PKCE_MISMATCH'],
  ])('classifies an explicit provider statement without returning it: %s',async(message,hint)=>{
    const result=await rejectionDiagnostic(new Response(JSON.stringify({message:message+'; PRIVATE_CODE_123'}),{status:400,headers:{'content-type':'application/json'}}));
    expect(result).toMatchObject({oauthError:'unrecognized',codeRejectionHints:[hint]});
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CODE_123');
    expect(JSON.stringify(result)).not.toContain(message);
  });

  it.each([
    'invalid_grant',
    'Check authorization code, client_id and redirect_uri.',
    'Authorization code is not expired.',
    'Authorization code has not already been used.',
    'Authorization code received; access token expired.',
    'Refresh token is invalid.',
    'Check whether authorization code is expired.',
    'Do not report invalid authorization code.',
    'Authorization code has expiredness.',
  ])('does not turn generic, unrelated, negated or advisory text into a cause: %s',async message=>{
    expect(await rejectionDiagnostic(new Response(JSON.stringify({message})))).not.toHaveProperty('codeRejectionHints');
  });

  it('keeps classifications bounded, deduplicated and only within known error fields',async()=>{
    const result=await rejectionDiagnostic(new Response(JSON.stringify({errors:[
      {message:'Authorization code expired'}, {detail:'Authorization code expired'},
    ],access_token:'Authorization code invalid',custom:{message:'Authorization code already used'}})));
    expect(result.codeRejectionHints).toEqual(['EXPIRED']);
    for(const body of [
      'Authorization code expired',
      {errors:[...Array.from({length:8},()=>({message:'unknown'})),{message:'Authorization code expired'}]},
      {error:{error:{error:{error:{message:'Authorization code expired'}}}}},
    ])expect(await rejectionDiagnostic(new Response(JSON.stringify(body)))).not.toHaveProperty('codeRejectionHints');
    const form=new Response('error_description=Authorization+code+expired&state=PRIVATE_STATE',{headers:{'content-type':'application/x-www-form-urlencoded'}});
    expect((await rejectionDiagnostic(form)).codeRejectionHints).toEqual(['EXPIRED']);
  });
});

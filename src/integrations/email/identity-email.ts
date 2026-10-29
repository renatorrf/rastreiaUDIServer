import type { EmailPayload } from './email.service.js';

export interface IdentityEmailInput {
  to:string;
  kind:'INVITE'|'VERIFY_EMAIL'|'RESET_PASSWORD';
  actionUrl:string;
  expiresAt:Date;
  requiresPassword?:boolean;
}
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,char=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
})[char]!);

export function createIdentityEmail(input:IdentityEmailInput):EmailPayload {
  const url=new URL(input.actionUrl);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('INVALID_EMAIL_ACTION_URL');
  const copy=input.kind==='RESET_PASSWORD'?{
    subject:'Redefina sua senha · RastreiaAPP',eyebrow:'SEGURANÇA DA CONTA',title:'Redefina sua senha.',
    description:'Recebemos uma solicitação para redefinir a senha da sua conta. Use o botão abaixo para escolher uma nova senha com segurança.',
    action:'Redefinir minha senha',duration:'1 hora',
    note:'Se você não solicitou esta alteração, ignore este e-mail. Sua senha continuará a mesma.',
  }:input.kind==='VERIFY_EMAIL'?{
    subject:'Confirme seu e-mail · RastreiaAPP',eyebrow:'CONFIRMAÇÃO DE E-MAIL',title:'Só falta confirmar seu e-mail.',
    description:'Seu cadastro no RastreiaAPP começou. Confirme este endereço de e-mail para continuar as próximas etapas no aplicativo.',
    action:'Confirmar meu e-mail',duration:'24 horas',
    note:'Se você não iniciou este cadastro, ignore este e-mail. Nenhuma confirmação será feita sem sua ação.',
  }:{
    subject:'Seu convite chegou · RastreiaAPP',eyebrow:'ACESSO À SUA UNIDADE',title:'Boas-vindas ao RastreiaAPP.',
    description:input.requiresPassword
      ?'Você recebeu um convite para acessar sua unidade. Confirme o convite e crie sua senha pessoal para começar.'
      :'Você recebeu um convite para acessar uma unidade. Confirme o convite e entre com a senha da sua conta.',
    action:input.requiresPassword?'Criar senha e aceitar convite':'Aceitar convite',duration:'24 horas',
    note:'Se você não reconhece este convite, ignore este e-mail. Não compartilhe este link com outras pessoas.',
  };
  const expiry=new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'}).format(input.expiresAt);
  const validity=`Válido por ${copy.duration} a partir da solicitação, até ${expiry} (horário de Brasília).`;
  const security='Este link é pessoal, temporário e de uso único. O RastreiaAPP nunca solicita sua senha por e-mail.';
  const href=escapeHtml(url.href);
  const text=[`RastreiaAPP — ${copy.eyebrow}`,copy.title,copy.description,
    `${copy.action}:\n${url.href}`,validity,security,copy.note,
    'RastreiaAPP · Gestão de entregas\nMensagem automática sobre sua conta.'].join('\n\n');
  const html=`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark">
<title>${escapeHtml(copy.subject)}</title>
<style>body{margin:0;padding:0}table{border-collapse:collapse}a{color:#35d07f} @media(max-width:480px){.outer{padding:20px 12px!important}.inner{padding:28px 20px!important}.title{font-size:28px!important}.brand{padding:0 8px 24px!important}}</style></head>
<body style="margin:0;padding:0;background-color:#111418;color:#f4f7fa;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(copy.description)}</div>
<table role="presentation" width="100%" bgcolor="#111418" style="width:100%;background-color:#111418;"><tr><td class="outer" align="center" style="padding:40px 16px;">
<!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->
<table role="presentation" width="100%" style="width:100%;max-width:600px;">
<tr><td class="brand" style="padding:0 16px 28px;font-size:23px;font-weight:bold;letter-spacing:-.5px;color:#f4f7fa;">Rastreia<span style="color:#35d07f;">APP</span></td></tr>
<tr><td class="inner" bgcolor="#1a1f25" style="padding:40px 36px;border:1px solid #3a444f;border-radius:20px;background-color:#1a1f25;">
<p style="margin:0 0 18px;color:#35d07f;font-size:11px;font-weight:bold;letter-spacing:2px;">${copy.eyebrow}</p>
<h1 class="title" style="margin:0 0 20px;color:#f4f7fa;font-size:34px;line-height:1.15;letter-spacing:-1px;">${copy.title}</h1>
<p style="margin:0 0 28px;color:#b8c1ca;font-size:16px;line-height:1.6;">${copy.description}</p>
<table role="presentation" width="100%" style="width:100%;"><tr><td align="center" bgcolor="#35d07f" style="background-color:#35d07f;border-radius:12px;mso-padding-alt:18px 16px;">
<a href="${href}" style="display:block;padding:18px 16px;border:1px solid #35d07f;border-radius:12px;color:#07150d;background-color:#35d07f;font-size:16px;font-weight:bold;line-height:1.3;text-decoration:none;">${copy.action}</a>
</td></tr></table>
<p style="margin:20px 0 0;color:#b8c1ca;font-size:13px;line-height:1.6;">${escapeHtml(validity)}</p>
<p style="margin:24px 0 0;padding-top:24px;border-top:1px solid #3a444f;color:#b8c1ca;font-size:13px;line-height:1.6;">${security}</p>
<p style="margin:18px 0 8px;color:#b8c1ca;font-size:12px;line-height:1.6;">O botão não abriu? Copie e cole o endereço completo no navegador:</p>
<p style="margin:0;font-size:12px;line-height:1.7;word-break:break-all;overflow-wrap:anywhere;"><a href="${href}" style="color:#35d07f;text-decoration:underline;word-break:break-all;">${href}</a></p>
</td></tr>
<tr><td style="padding:24px 16px 0;color:#b8c1ca;font-size:12px;line-height:1.7;">
<p style="margin:0 0 16px;">${copy.note}</p><p style="margin:0;color:#f4f7fa;font-weight:bold;">RastreiaAPP · Gestão de entregas</p>
<p style="margin:4px 0 0;">Mensagem automática sobre sua conta.</p></td></tr>
</table><!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
  return {to:input.to,subject:copy.subject,text,html};
}

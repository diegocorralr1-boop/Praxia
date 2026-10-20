// Praxia · Registro — aplicación (antes inline en index.html). Sin build: se sirve tal cual.
// Project URL + publishable key come from config.js (one block per environment). The key is public by
// design; access control lives in the database (RLS + RPCs, see the .sql migrations).
const CFG=window.PRAXIA_CONFIG||{};
const SUPABASE_URL=(CFG.current&&CFG.current.supabaseUrl)||"https://yqsgeywhilqrsombekce.supabase.co";
const SUPABASE_KEY=(CFG.current&&CFG.current.supabaseKey)||"sb_publishable_U5Li7wfZ_ttx9wYlEnqSKQ_CjvQKbVB";
const APP_VERSION=CFG.version||"dev";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// Legal: datos del responsable y versión vigente del Aviso/Términos (legal-config.js).
const LEGAL=window.PRAXIA_LEGAL||{};
const TERMS_VERSION=LEGAL.version||"2026-10-17";
const MIN_PASS=10;            // Supabase: Authentication → Providers → Email → Minimum password length = 10
const IDLE_MS=30*60*1000;     // cierre de sesión por inactividad (equipos compartidos en recepción)
// true when a Supabase error means the RPC/column doesn't exist yet (migration 0005 not applied)
const rpcMissing=e=>!!e&&(e.code==="PGRST202"||e.code==="42883"||e.code==="42703"||e.code==="42P01"||/schema cache|does not exist/i.test(e.message||""));

const DEFAULT_CATS = {
  concepto:["REV","PRIMERA VEZ","SUBSECUENTE","CV","OCT","LASER G6","LASER SLT","LASER YAG","LENTES","LENTES DE CONTACTO","ANTICIPO DE LENTES","ABONO DE CIRUGÍA","CHALAZION","FACO","TRABE","VALVULA","DIODO"],
  modificador:["OD","OI","AO","Control","Postoperatorio","Paquete"],
  estatus:["Completo","Descuento","Cortesía"],
  metodo:["Pesos (MXN)","Dolares (USD)","Tarjeta","Clip","Transferencia"],
  tipo_tarjeta:["DEBITO","CREDITO"]
};
const DOW=["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
const MONTHS=["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

const DEFAULT_CAPS={dailyTotals:true,monthlyTotals:false,analytics:false,editCategories:true,editFx:true,exportData:false,deleteEntries:true,editEntries:true};
let me={user:null,clinicId:null,role:null,clinicName:null,displayName:null,fx:18.5,caps:null,status:null,isAdmin:false,isOwner:false,lastState:null};
function can(cap){return me.role==="manager"||!!(me.caps&&me.caps[cap]);}
// Mirrors can_read_entry_date() in 0004: without these caps Recepción only sees 7 days.
function fullHistory(){return can("monthlyTotals")||can("analytics")||can("exportData");}
let cats={concepto:[],modificador:[],estatus:[],metodo:[],tipo_tarjeta:[],cur:{}};
let entriesCache=[];
let calMonth=null;
let settingsTab="preferencias";

const $=s=>document.querySelector(s);
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
// Options for a <select>: keeps the value already saved on an entry even if the category was deleted later.
const withVal=(arr,val)=>val&&!arr.includes(val)?[val,...arr]:arr;
const fmtMXN=n=>"$"+Math.round(n).toLocaleString("es-MX");
const initials=n=>(n||"?").trim().split(/\s+/).slice(0,2).map(w=>w[0]).join("").toUpperCase();
const parseDate=s=>{const[y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d);};
// Local (clinic) date, not UTC — UTC flips to tomorrow in the evening in Tijuana.
const todayISO=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");};
// Supabase returns at most 1000 rows per request ("Max rows"); page until a request comes back short.
// `q` builds a fresh query each call and must end with a stable order (.order("id")).
async function fetchAll(q){const out=[];for(;;){const {data,error}=await q().range(out.length,out.length+999);if(error)return {data:null,error};out.push(...(data||[]));if(!data||data.length<1000)return {data:out,error:null};}}
function methodCur(m){return cats.cur[m]||(/(usd|d[oó]lar)/i.test(m||"")?"USD":"MXN");}
function itemMethod(e,it){return it.method||e.method;}
function itemCur(e,it){return it.currency||methodCur(itemMethod(e,it));}
// USD lines convert at the rate frozen on the entry, so changing TC doesn't rewrite history.
function itemMXN(e,it){const a=Number(it.amount)||0;return itemCur(e,it)==="USD"?a*(Number(e.fx_rate)||me.fx):a;}
function entryMXN(e){return (e.entry_items||[]).reduce((s,it)=>s+itemMXN(e,it),0);}
// Split a line's amount across n conceptos in whole cents; remainder goes to the first.
function splitCents(total,n){const c=Math.round((Number(total)||0)*100),b=Math.floor(c/n),out=Array(n).fill(b);out[0]+=c-b*n;return out.map(x=>x/100);}
// Neutralise spreadsheet formulas (=, +, -, @) in exported text cells.
const csvCell=c=>{let v=String(c==null?"":c);if(typeof c==="string"&&/^[=+\-@\t\r]/.test(v))v="'"+v;return `"${v.replace(/"/g,'""')}"`;};
function shortMethod(m){return /MXN/i.test(m)?"MXN":/USD/i.test(m)?"USD":m;}
function entryMethods(e){return [...new Set((e.entry_items||[]).map(it=>shortMethod(itemMethod(e,it))))];}
function entryConceptos(e){const seen=[],out=[];(e.entry_items||[]).forEach(it=>{const k=it.concepto+"|"+(it.modificador||"");if(!seen.includes(k)){seen.push(k);out.push(it);}});return out;}
function toast(msg,bad){const t=$("#toast");$("#toast-msg").textContent=msg;t.classList.toggle("bad",!!bad);t.classList.add("show");clearTimeout(toast._t);toast._t=setTimeout(()=>t.classList.remove("show"),2600);}

/* ---- ERROR REPORTING (0007) ---- */
// Uncaught errors go to client_errors so the platform admins see what users hit. Capped per page
// load; the server caps per user per hour and keeps 90 days. Silently skipped before 0007.
let errReports=0;
function reportClientError(msg,stack){
  if(errReports>=10||!me.user)return;errReports++;
  try{sb.rpc("log_client_error",{p_message:String(msg||"").slice(0,500),p_stack:String(stack||"").slice(0,4000),p_url:location.pathname+location.hash.slice(0,80),p_version:APP_VERSION,p_user_agent:navigator.userAgent}).then(()=>{},()=>{});}catch(_){}
}
window.addEventListener("error",e=>reportClientError(e.message,e.error&&e.error.stack));
window.addEventListener("unhandledrejection",e=>{const r=e.reason||{};if(r.name==="AbortError")return;reportClientError(r.message||String(r),r.stack);if(me.user)toast("Algo salió mal. Si persiste, recarga la página.",true);});

/* ---- AUTH ---- */
function showLoginView(v){["login","signup","join","reset","newpass","confirm","onboard","blocked"].forEach(x=>$("#v-"+x).classList.toggle("hidden",x!==v));$("#lock").style.display="flex";}
const fmtCode=c=>String(c||"").replace(/(.{4})(?=.)/g,"$1-");
// Supabase / RPC error codes → Spanish, for the sign-up and membership flows.
function errText(e){
  const m=(e&&e.message)||String(e||"");
  const T=[[/invalid_or_used_code|not_found/,"El código no es válido o ya se usó."],[/expired_code|expired/,"El código venció. Pide uno nuevo."],[/revoked/,"Esa invitación fue cancelada."],
    [/invite_for_other_email/,"Esa invitación es para otro correo."],[/code_reserved_by_other/,"Ese código ya lo está usando otra persona."],[/clinic_not_active|clinic_suspended/,"Ese consultorio está suspendido."],
    [/already_in_clinic/,"Tu cuenta ya pertenece a un consultorio."],[/account_disabled/,"Tu acceso fue deshabilitado."],[/bad_clinic_name/,"Escribe el nombre del consultorio (máximo 120 caracteres)."],
    [/too_many_attempts/,"Demasiados intentos. Espera una hora."],[/last_manager/,"El consultorio necesita al menos un gerente activo."],[/cannot_change_owner/,"Solo un administrador puede cambiar al propietario del consultorio."],
    [/cannot_remove_self|cannot_change_self|cannot_delete_self/,"No puedes hacer eso con tu propia cuenta."],[/delete_clinic_first/,"Primero elimina el consultorio (o pasa la propiedad a otro gerente)."],[/not_a_member/,"Esa persona no pertenece a un consultorio."],
    [/no_permission/,"No tienes permiso para esto."],[/over_email_send_rate_limit|rate limit/i,"Espera un minuto antes de pedir otro correo."],[/Email not confirmed/i,"Confirma tu correo antes de entrar."],
    [/Invalid login credentials/i,"Correo o contraseña incorrectos."],[/Password should be|weak_password/i,"La contraseña es demasiado débil."],[/bad_email/,"Ese correo no es válido."]];
  for(const [re,t] of T)if(re.test(m))return t;
  return m;
}
// Enter in any field of a lock-screen form presses that form's button.
[["#v-login","#btn-login"],["#v-signup","#btn-signup"],["#v-join","#btn-join"],["#v-reset","#btn-reset"],["#v-newpass","#btn-newpass"],["#v-confirm","#btn-resend"]]
  .forEach(([v,b])=>$(v).addEventListener("keydown",e=>{if(e.key==="Enter"&&e.target.tagName==="INPUT"&&e.target.type!=="checkbox"){e.preventDefault();$(b).click();}}));
$("#go-join").onclick=()=>showLoginView("join");
$("#go-login2").onclick=()=>showLoginView("login");
// Live check of an invite code (check_invite is callable before signing in). Returns null when 0006 isn't applied.
async function checkInvite(code){
  if(!code||code.replace(/[^a-z0-9]/gi,"").length<16)return undefined;
  const {data,error}=await sb.rpc("check_invite",{p_code:code});
  if(error)return rpcMissing(error)?null:{valid:false,reason:error.message};
  return data;
}
function inviteInfoText(r){
  if(r===undefined)return "";
  if(r===null)return "";
  if(r.valid)return `Te unirás a ${r.clinic_name} como ${r.role==="manager"?"Gerente":"Recepción"}.`;
  return errText({message:r.reason||"not_found"});
}
let joinChkT=null;
$("#jo-code").addEventListener("input",()=>{clearTimeout(joinChkT);const m=$("#join-msg");joinChkT=setTimeout(async()=>{const r=await checkInvite($("#jo-code").value);m.className="lmsg "+(r&&r.valid?"ok":r&&r.valid===false?"err":"");m.textContent=inviteInfoText(r);},350);});
$("#btn-join").onclick=async()=>{
  const m=$("#join-msg");m.className="lmsg";
  const name=$("#jo-name").value.trim(),email=$("#jo-email").value.trim(),pass=$("#jo-pass").value,code=$("#jo-code").value.trim();
  if(!name||!email||pass.length<MIN_PASS||!code){m.classList.add("err");m.textContent=`Llena todos los campos (contraseña de ${MIN_PASS}+ caracteres).`;return;}
  if(!$("#jo-acepto").checked){m.classList.add("err");m.textContent="Para continuar, acepta el Aviso de privacidad y los Términos.";return;}
  const b=$("#btn-join");b.disabled=true;m.textContent="Verificando código...";
  try{
    const chk=await checkInvite(code);
    if(chk&&chk.valid===false){throw new Error(chk.reason||"not_found");}
    if(chk&&chk.valid&&chk.email&&chk.email.toLowerCase()!==email.toLowerCase()){throw new Error("invite_for_other_email");}
    m.textContent="Creando tu cuenta...";
    // terms_* in user metadata = proof of the tick at sign-up; the server finishes the sign-up from pending_invite.
    const {data:su,error:e1}=await sb.auth.signUp({email,password:pass,options:{emailRedirectTo:location.origin+location.pathname,data:{pending_invite:code,display_name:name,terms_version:TERMS_VERSION,terms_accepted_at:new Date().toISOString()}}});if(e1)throw e1;
    if(su.user&&Array.isArray(su.user.identities)&&su.user.identities.length===0){m.classList.add("err");m.textContent="Este correo ya tiene una cuenta. Entra con tu contraseña o restablécela.";b.disabled=false;return;}
    if(!su.session){b.disabled=false;showConfirm(email,"Te enviamos un correo para confirmar tu cuenta.");return;}
    await initApp();
  }catch(err){m.classList.add("err");m.textContent=errText(err);b.disabled=false;}
};
$("#go-signup").onclick=()=>showLoginView("signup");
$("#go-login").onclick=()=>showLoginView("login");

$("#btn-signup").onclick=async()=>{
  const m=$("#signup-msg");m.className="lmsg";
  const clinic=$("#su-clinic").value.trim(),name=$("#su-name").value.trim(),email=$("#su-email").value.trim(),pass=$("#su-pass").value;
  if(!clinic||!email||pass.length<MIN_PASS){m.classList.add("err");m.textContent=`Llena consultorio, correo y contraseña de ${MIN_PASS}+ caracteres.`;return;}
  if(!$("#su-acepto").checked){m.classList.add("err");m.textContent="Para continuar, acepta el Aviso de privacidad y los Términos.";return;}
  const b=$("#btn-signup");b.disabled=true;m.textContent="Creando...";
  try{
    // The server creates the clinic from pending_clinic when the email is confirmed (0006).
    const {data:su,error:e1}=await sb.auth.signUp({email,password:pass,options:{emailRedirectTo:location.origin+location.pathname,data:{pending_clinic:clinic,display_name:name||"Gerente",terms_version:TERMS_VERSION,terms_accepted_at:new Date().toISOString()}}});if(e1)throw e1;
    if(su.user&&Array.isArray(su.user.identities)&&su.user.identities.length===0){m.classList.add("err");m.textContent="Este correo ya tiene una cuenta. Entra con tu contraseña o restablécela.";b.disabled=false;return;}
    if(!su.session){b.disabled=false;showConfirm(email,"Te enviamos un correo para confirmar tu cuenta.");return;}
    await initApp();
  }catch(err){m.classList.add("err");m.textContent=errText(err);b.disabled=false;}
};
$("#btn-login").onclick=async()=>{
  const m=$("#login-msg");m.className="lmsg";
  const email=$("#li-email").value.trim(),pass=$("#li-pass").value;
  const b=$("#btn-login");b.disabled=true;m.textContent="Entrando...";
  try{const {error}=await sb.auth.signInWithPassword({email,password:pass});if(error)throw error;await initApp();}
  catch(err){m.classList.add("err");m.textContent=errText(err);b.disabled=false;if(/Email not confirmed/i.test(err.message||""))showConfirm(email,"Tu correo aún no está confirmado.");}
};
$("#btn-logout").onclick=async()=>{await sb.auth.signOut();location.reload();};

/* ---- PASSWORD RESET ---- */
// The reset link signs the user in and fires PASSWORD_RECOVERY: ask for a new password instead of opening the app.
let recovering=/type=recovery/.test(location.hash)||/type=recovery/.test(location.search);
sb.auth.onAuthStateChange(ev=>{if(ev==="PASSWORD_RECOVERY"){recovering=true;$("#lock").style.display="flex";$("#app").style.display="none";showLoginView("newpass");}});
$("#go-reset").onclick=()=>showLoginView("reset");
$("#go-login3").onclick=()=>showLoginView("login");
$("#btn-reset").onclick=async()=>{
  const m=$("#reset-msg");m.className="lmsg";const email=$("#rs-email").value.trim();
  if(!email){m.classList.add("err");m.textContent="Escribe tu correo.";return;}
  const b=$("#btn-reset");b.disabled=true;m.textContent="Enviando...";
  const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});
  b.disabled=false;
  if(error&&!/user not found/i.test(error.message)){m.classList.add("err");m.textContent="Error: "+error.message;return;}
  // Same message whether or not the account exists.
  m.classList.add("ok");m.textContent="Si el correo está registrado, recibirás un enlace para elegir una nueva contraseña.";
};
$("#btn-newpass").onclick=async()=>{
  const m=$("#newpass-msg");m.className="lmsg";const p1=$("#np-pass").value,p2=$("#np-pass2").value;
  if(p1.length<MIN_PASS){m.classList.add("err");m.textContent=`La contraseña debe tener al menos ${MIN_PASS} caracteres.`;return;}
  if(p1!==p2){m.classList.add("err");m.textContent="Las contraseñas no coinciden.";return;}
  const b=$("#btn-newpass");b.disabled=true;m.textContent="Guardando...";
  const {error}=await sb.auth.updateUser({password:p1});
  if(error){b.disabled=false;m.classList.add("err");m.textContent="Error: "+error.message;return;}
  recovering=false;history.replaceState(null,"",location.pathname);
  toast("Contraseña actualizada");await initApp();
};

/* ---- ACCOUNT STATE & ONBOARDING (0006) ---- */
async function accountState(){
  const {data,error}=await sb.rpc("my_account_state");
  if(error){if(rpcMissing(error))return null;throw error;}
  return data;
}
// Before 0006 is applied: best effort from the tables (the self-read policy of 0006 is what makes this reliable).
async function legacyState(user){
  const md=user.user_metadata||{};
  // Only columns that exist since 0001; terms_version (0005) is read separately by ensureTerms().
  const {data:p,error}=await sb.from("profiles").select("role,clinic_id,display_name").eq("id",user.id).maybeSingle();
  if(error)throw error;
  if(!p||!p.clinic_id)return {status:"needs_clinic",legacy:true,display_name:p&&p.display_name,pending:{clinic_name:md.pending_clinic||null,invite:md.pending_invite?true:null}};
  const [{data:c},{data:s}]=await Promise.all([sb.from("clinics").select("name").eq("id",p.clinic_id).maybeSingle(),sb.from("clinic_settings").select("fx_rate,recepcion_caps").eq("clinic_id",p.clinic_id).maybeSingle()]);
  return {status:"active",legacy:true,role:p.role,display_name:p.display_name,terms_version:undefined,clinic:{id:p.clinic_id,name:c?c.name:"Consultorio"},fx_rate:s&&s.fx_rate,caps:s&&s.recepcion_caps,is_admin:false};
}
// Finishes a pending sign-up: server-side when 0006 exists, otherwise directly with the RPCs from 0001/0002.
async function retryOnboarding(st,user){
  if(!st.legacy){const {data,error}=await sb.rpc("finish_onboarding");if(error)throw error;return data;}
  const md=user.user_metadata||{};
  if(md.pending_clinic){const {error}=await sb.rpc("bootstrap_clinic",{p_clinic_name:md.pending_clinic,p_display_name:md.display_name||"Gerente"});if(error)throw error;return "active";}
  if(md.pending_invite){const {data,error}=await sb.rpc("accept_invite",{p_code:md.pending_invite});if(error)throw error;if(!data)throw new Error("invalid_or_used_code");return "active";}
  return "needs_clinic";
}
let pendingEmail="",resendT=null;
function showConfirm(email,msg){
  pendingEmail=email||pendingEmail;$("#cf-email").value=pendingEmail;
  const m=$("#confirm-msg");m.className="lmsg"+(msg?" ok":"");m.textContent=msg||"";
  showLoginView("confirm");
}
$("#go-login4").onclick=()=>location.reload();
$("#btn-resend").onclick=async()=>{
  const m=$("#confirm-msg"),b=$("#btn-resend"),email=$("#cf-email").value.trim();m.className="lmsg";
  if(!email){m.classList.add("err");m.textContent="Escribe tu correo.";return;}
  b.disabled=true;m.textContent="Enviando...";
  const {error}=await sb.auth.resend({type:"signup",email,options:{emailRedirectTo:location.origin+location.pathname}});
  if(error){b.disabled=false;m.classList.add("err");m.textContent=errText(error);return;}
  m.classList.add("ok");m.textContent="Correo reenviado. Revisa tu bandeja y la carpeta de spam.";
  let s=60;b.textContent=`Reenviar (${s})`;clearInterval(resendT);resendT=setInterval(()=>{s--;if(s<=0){clearInterval(resendT);b.disabled=false;b.textContent="Reenviar correo";}else b.textContent=`Reenviar (${s})`;},1000);
};
function showOnboarding(st,user){
  me.lastState=st;
  const pend=st.pending&&(st.pending.clinic_name||st.pending.invite);
  $("#ob-title").textContent=pend?"Terminando tu alta":"Termina tu alta";
  $("#ob-sub").textContent=st.pending&&st.pending.clinic_name?`Consultorio pendiente: ${st.pending.clinic_name}`:st.pending&&st.pending.invite?"Tienes una invitación pendiente":"Tu cuenta aún no pertenece a ningún consultorio";
  $("#ob-error").textContent=st.onboarding_error?"No se pudo completar: "+errText({message:st.onboarding_error}):"";
  $("#ob-retry").classList.toggle("hidden",!pend);
  $("#ob-choose").classList.remove("hidden");$("#ob-form-create").classList.add("hidden");$("#ob-form-code").classList.add("hidden");$("#ob-back").classList.add("hidden");
  $("#ob-msg").className="lmsg";$("#ob-msg").textContent="";
  showLoginView("onboard");
  const back=()=>{$("#ob-choose").classList.remove("hidden");$("#ob-form-create").classList.add("hidden");$("#ob-form-code").classList.add("hidden");$("#ob-back").classList.add("hidden");};
  $("#ob-back").onclick=back;
  $("#ob-create").onclick=()=>{$("#ob-choose").classList.add("hidden");$("#ob-form-create").classList.remove("hidden");$("#ob-back").classList.remove("hidden");$("#ob-name").value=st.display_name||"";setTimeout(()=>$("#ob-clinic").focus(),50);};
  $("#ob-code").onclick=()=>{$("#ob-choose").classList.add("hidden");$("#ob-form-code").classList.remove("hidden");$("#ob-back").classList.remove("hidden");setTimeout(()=>$("#ob-codein").focus(),50);};
  const run=async(btn,fn)=>{const m=$("#ob-msg");m.className="lmsg";m.textContent="Un momento...";btn.disabled=true;
    try{await fn();await initApp();}catch(err){m.classList.add("err");m.textContent=errText(err);}finally{btn.disabled=false;}};
  $("#ob-retry").onclick=()=>run($("#ob-retry"),async()=>{const r=await retryOnboarding(st,user);if(r!=="active")throw new Error((await accountState()||{}).onboarding_error||"No se pudo completar el alta.");});
  $("#ob-create-go").onclick=()=>run($("#ob-create-go"),async()=>{const name=$("#ob-clinic").value.trim();if(!name)throw new Error("bad_clinic_name");const {error}=await sb.rpc("bootstrap_clinic",{p_clinic_name:name,p_display_name:$("#ob-name").value.trim()||null});if(error)throw error;});
  $("#ob-code-go").onclick=()=>run($("#ob-code-go"),async()=>{const code=$("#ob-codein").value.trim();if(!code)throw new Error("not_found");const {data,error}=await sb.rpc("accept_invite",{p_code:code});if(error)throw error;if(!data)throw new Error("invalid_or_used_code");});
  let t=null;$("#ob-codein").oninput=()=>{clearTimeout(t);t=setTimeout(async()=>{const r=await checkInvite($("#ob-codein").value);const i=$("#ob-codeinfo");i.className="lmsg "+(r&&r.valid?"ok":r&&r.valid===false?"err":"");i.textContent=inviteInfoText(r);},350);};
  $("#ob-logout").onclick=async()=>{await sb.auth.signOut();location.reload();};
}
function showBlocked(st){
  const susp=st.status==="clinic_suspended";
  $("#bl-title").textContent=susp?"Consultorio suspendido":"Acceso deshabilitado";
  $("#bl-sub").textContent=susp?`${st.clinic?st.clinic.name:"Tu consultorio"} está suspendido. Contacta a Praxia.`:"Tu gerente deshabilitó tu acceso. Habla con tu consultorio si crees que es un error.";
  $("#bl-logout").onclick=async()=>{await sb.auth.signOut();location.reload();};
  showLoginView("blocked");
}

/* ---- CONSENT (Aviso + Términos) ---- */
// Resolves true when the user has accepted TERMS_VERSION (or the consent columns don't exist yet).
async function ensureTerms(user,tv){
  if(tv===undefined){
    const {data,error}=await sb.from("profiles").select("terms_version").eq("id",user.id).maybeSingle();
    if(error){if(rpcMissing(error))console.warn("Migración 0005 no aplicada: sin registro de consentimiento.");return true;}
    tv=data&&data.terms_version;
  }
  if(tv===TERMS_VERSION)return true;
  const md=user.user_metadata||{};
  if(md.terms_version===TERMS_VERSION){await acceptTerms();return true;}   // ticked the box at sign-up
  return await showConsent();
}
async function acceptTerms(){
  const {error}=await sb.rpc("accept_terms",{p_version:TERMS_VERSION});
  if(error){if(rpcMissing(error))return null;toast("No se pudo guardar la aceptación: "+error.message,true);return false;}
  return true;
}
function showConsent(){
  return new Promise(resolve=>{
    const box=$("#consent"),chk=$("#consent-chk"),ok=$("#consent-ok");
    $("#consent-ver").textContent=TERMS_VERSION;chk.checked=false;ok.disabled=true;box.classList.add("open");
    chk.onchange=()=>ok.disabled=!chk.checked;
    ok.onclick=async()=>{ok.disabled=true;const r=await acceptTerms();if(r===false){ok.disabled=false;return;}box.classList.remove("open");resolve(true);};
    $("#consent-no").onclick=async()=>{box.classList.remove("open");await sb.auth.signOut();location.reload();resolve(false);};
  });
}

/* ---- IDLE LOGOUT ---- */
let idleT=null,idleWarnT=null;
function startIdleTimer(){
  if(startIdleTimer.on)return;startIdleTimer.on=true;
  const reset=()=>{clearTimeout(idleT);clearTimeout(idleWarnT);
    idleWarnT=setTimeout(()=>toast("Tu sesión se cerrará en 1 minuto por inactividad"),IDLE_MS-60000);
    idleT=setTimeout(async()=>{await sb.auth.signOut();location.replace(location.pathname+"?inactivo=1");},IDLE_MS);};
  ["mousemove","keydown","click","touchstart","scroll"].forEach(ev=>document.addEventListener(ev,reset,{passive:true}));
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)reset();});
  reset();
}

/* ---- INIT ---- */
async function initApp(){
  const {data:{user}}=await sb.auth.getUser();
  if(!user){$("#lock").style.display="flex";$("#app").style.display="none";return;}
  if(recovering){$("#lock").style.display="flex";$("#app").style.display="none";showLoginView("newpass");return;}
  me.user=user;
  // One call tells the app what to show (0006). The server already finished the
  // sign-up when the email was confirmed; the app only retries or shows the state.
  let st;
  try{st=(await accountState())||(await legacyState(user));}
  catch(err){const m=$("#login-msg");m.className="lmsg err";m.textContent="No se pudo cargar tu cuenta: "+errText(err);$("#btn-login").disabled=false;showLoginView("login");return;}
  if(st.status==="pending_email"){showConfirm(user.email,"");return;}
  if(st.status==="needs_clinic"&&st.pending&&(st.pending.clinic_name||st.pending.invite)&&!st.onboarding_error){
    try{if((await retryOnboarding(st,user))==="active")st=(await accountState())||(await legacyState(user));}
    catch(err){st.onboarding_error=err.message||String(err);}
  }
  if(st.status==="disabled"||st.status==="clinic_suspended"){showBlocked(st);return;}
  if(st.status!=="active"&&!st.is_admin){showOnboarding(st,user);return;}
  me.lastState=st;me.isAdmin=!!st.is_admin;me.displayName=st.display_name||(st.is_admin?"Administración":"Usuario");
  if(!(await ensureTerms(user,st.terms_version)))return;
  if(st.status!=="active"){startAdminOnly(st);return;}
  me.status="active";me.role=st.role;me.clinicId=st.clinic.id;me.clinicName=st.clinic.name;me.isOwner=!!st.clinic.is_owner;
  me.fx=Number(st.fx_rate)||18.5;me.caps=Object.assign({},DEFAULT_CAPS,st.caps||{});
  await seedCatsIfEmpty();
  await loadCats();
  showApp();
  setView("entries");
  startIdleTimer();
}
function showApp(){
  $("#lock").style.display="none";$("#app").style.display="block";
  $("#s-name").textContent=me.displayName;$("#s-clinic").textContent=me.clinicName;
  $("#s-ava").textContent=(me.displayName[0]||"G").toUpperCase();
  $("#role-badge").textContent=me.status==="admin_only"?"Admin":me.role==="manager"?"Gerente":"Recepción";
  $("#role-badge").className="role-badge "+(me.role==="manager"||me.status==="admin_only"?"mgr":"rec");
  document.querySelectorAll("#nav button").forEach(b=>{const v=b.dataset.view;
    b.style.display=v==="admin"?(me.isAdmin?"flex":"none"):v==="analytics"?(me.status==="active"&&can("analytics")?"flex":"none"):(me.status==="active"?"flex":"none");});
}
// Platform admin without a clinic of their own: only the admin panel is available.
function startAdminOnly(st){
  me.status="admin_only";me.role=null;me.clinicId=null;me.clinicName="Praxia";me.caps={};
  showApp();setView("admin");startIdleTimer();
}

async function seedCatsIfEmpty(){
  const {count,error}=await sb.from("categories").select("*",{count:"exact",head:true}).eq("clinic_id",me.clinicId);
  if(error||count!==0)return;   // only seed a clinic that really has none; never on a failed count
  const rows=[];
  for(const kind in DEFAULT_CATS) DEFAULT_CATS[kind].forEach((label,i)=>rows.push({clinic_id:me.clinicId,kind,label,sort_order:i}));
  const {error:e2}=await sb.from("categories").insert(rows);
  if(e2)console.warn("No se pudieron crear las categorías iniciales:",e2.message);
}
// The entry form's dropdowns come from here. A failed read (missing column before 0004, RLS, network)
// must never leave them empty: fall back to the defaults for the required kinds and say so.
async function loadCats(){
  let {data,error}=await sb.from("categories").select("kind,label,currency").eq("clinic_id",me.clinicId).eq("active",true).order("sort_order");
  if(error&&error.code==="42703")({data,error}=await sb.from("categories").select("kind,label").eq("clinic_id",me.clinicId).eq("active",true).order("sort_order"));
  cats={concepto:[],modificador:[],estatus:[],metodo:[],tipo_tarjeta:[],cur:{},fallback:[],loadError:error?error.message:null};
  (data||[]).forEach(r=>{if(cats[r.kind])cats[r.kind].push(r.label);if(r.kind==="metodo"&&r.currency)cats.cur[r.label]=r.currency;});
  ["concepto","estatus","metodo"].forEach(k=>{if(!cats[k].length){cats[k]=DEFAULT_CATS[k].slice();cats.fallback.push(k);}});
  if(error)toast("No se pudieron cargar las categorías ("+errText(error)+"). Se usan las predeterminadas.",true);
}

/* ---- ROUTER ---- */
const TITLES={entries:["Panel","Entradas"],calendar:["Vista","Calendario"],crm:["Base de datos","Pacientes"],analytics:["Reportes","Analíticas"],settings:["Sistema","Ajustes"],admin:["Plataforma","Administración"]};
function setView(v){
  if(v==="analytics"&&!can("analytics"))v="entries";
  if(v==="admin"&&!me.isAdmin)v="entries";
  if(me.status==="admin_only")v="admin";
  curView=v;
  document.querySelectorAll("#nav button").forEach(b=>b.classList.toggle("active",b.dataset.view===v));
  $("#crumb").textContent=TITLES[v][0];$("#page-title").textContent=TITLES[v][1];
  $("#btn-new").style.display=v==="entries"?"inline-flex":"none";
  if(v==="entries")renderEntries();
  else if(v==="calendar")renderCalendar();
  else if(v==="analytics")renderAnalytics();
  else if(v==="crm")renderCRM();
  else if(v==="settings")renderSettings();
  else if(v==="admin")renderAdmin();
  else $("#content").innerHTML=`<div class="placeholder"><b>Próximamente</b>Esta sección se conecta en el siguiente paso.</div>`;
}
$("#nav").querySelectorAll("button").forEach(b=>b.onclick=()=>{setView(b.dataset.view);closeSide();});
function openSide(){document.querySelector(".side").classList.add("open");$("#side-scrim").classList.add("open");}
function closeSide(){document.querySelector(".side").classList.remove("open");$("#side-scrim").classList.remove("open");}
$("#menu-btn").onclick=openSide;$("#side-scrim").onclick=closeSide;

/* ---- ENTRIES ---- */
async function renderEntries(){
  $("#content").innerHTML=`<div class="loading">Cargando entradas...</div>`;
  const {data,error}=await fetchAll(()=>sb.from("entries")
    .select("id,entry_date,status,method,card_type,invoice_no,notes,created_at,fx_rate,patients(name,phone),entry_items(concepto,modificador,amount,method,currency)")
    .order("entry_date",{ascending:false}).order("created_at",{ascending:false}).order("id"));
  if(error){$("#content").innerHTML=`<div class="empty"><b>Error al cargar</b>${esc(error.message)}</div>`;return;}
  entriesCache=data||[];
  if(!entriesCache.length){
    $("#content").innerHTML=`<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6M9 13h6M9 17h3" stroke-linecap="round"/></svg><b>Sin entradas todavía</b>Crea la primera con “Nueva entrada”.</div>`;return;
  }
  const byDay={};entriesCache.forEach(e=>{(byDay[e.entry_date]=byDay[e.entry_date]||[]).push(e);});
  let html=fullHistory()?"":`<p class="note">Se muestran los últimos 7 días. Tu gerente puede ampliar el historial en Ajustes → Preferencias.</p>`;
  Object.keys(byDay).sort().reverse().forEach(d=>{
    const es=byDay[d],dt=parseDate(d),tot=es.reduce((s,e)=>s+entryMXN(e),0);
    const pac=new Set(es.map(e=>(e.patients&&e.patients.name||"").toLowerCase())).size;
    html+=`<div class="day-block"><div class="day-head"><div class="dl">
      <span class="dd">${dt.getDate()} ${MONTHS[dt.getMonth()]}</span><span class="dw">${DOW[dt.getDay()]}</span></div>
      <div class="dt">${can("dailyTotals")?fmtMXN(tot):"—"}<small>${pac} paciente${pac!==1?"s":""}</small></div></div>
      <div class="elist">${es.map(rowHTML).join("")}</div></div>`;
  });
  $("#content").innerHTML=html;
  bindRows($("#content"));
}
function bindRows(root){
  root.querySelectorAll("[data-edit]").forEach(b=>b.onclick=()=>{const e=entriesCache.find(x=>x.id===b.dataset.edit);if(e)openSheet(e);});
  root.querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>deleteEntry(b.dataset.del));
}
async function deleteEntry(id){
  if(!confirm("¿Eliminar esta entrada? No se puede deshacer."))return;
  const {error}=await sb.from("entries").delete().eq("id",id);
  if(error){toast("Error: "+error.message,true);return;}
  toast("Entrada eliminada");
  entriesCache=entriesCache.filter(e=>e.id!==id);
  curView==="calendar"?drawCalendar():renderEntries();
}
function rowHTML(e){
  const mxn=entryMXN(e);
  const pname=(e.patients&&e.patients.name)||"—";
  const tags=entryConceptos(e).map(it=>`<span class="tag concept">${esc(it.concepto)}${it.modificador?" · "+esc(it.modificador):""}</span>`).join("");
  return `<div class="erow">
    <div class="pname"><span class="pava">${esc(initials(pname))}</span>${esc(pname)}</div>
    <div class="concepts">${tags}</div>
    <div class="method">${esc(entryMethods(e).join(" + "))}</div>
    <div class="pst st-${esc(e.status)}"><span class="dot"></span>${esc(e.status)}</div>
    <div class="amt">${fmtMXN(mxn)}
      <span class="row-acts">
        ${can("editEntries")?`<button class="icon-btn" data-edit="${e.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 20h4L18 10l-4-4L4 16v4Z"/><path d="M13 7l4 4" stroke-linecap="round"/></svg></button>`:""}
        ${can("deleteEntries")?`<button class="icon-btn del" data-del="${e.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" stroke-linecap="round"/></svg></button>`:""}
      </span></div></div>`;
}

/* ---- CALENDAR ---- */
function dailyTotals(){
  const m={};
  entriesCache.forEach(e=>{const k=e.entry_date;m[k]=m[k]||{count:0,total:0,pac:new Set()};m[k].count++;m[k].total+=entryMXN(e);m[k].pac.add(((e.patients&&e.patients.name)||"").toLowerCase());});
  return m;
}
async function renderCalendar(){
  $("#content").innerHTML=`<div class="loading">Cargando calendario...</div>`;
  const {data,error}=await fetchAll(()=>sb.from("entries")
    .select("id,entry_date,status,method,card_type,invoice_no,notes,created_at,fx_rate,patients(name,phone),entry_items(concepto,modificador,amount,method,currency)")
    .order("entry_date",{ascending:false}).order("created_at",{ascending:false}).order("id"));
  if(error){$("#content").innerHTML=`<div class="empty"><b>Error al cargar</b>${esc(error.message)}</div>`;return;}
  entriesCache=data||[];
  if(!calMonth){const d=new Date();calMonth=d.getFullYear()+"-"+d.getMonth();}
  drawCalendar();
}
function drawCalendar(){
  const [y,m]=calMonth.split("-").map(Number);
  const startDow=new Date(y,m,1).getDay(),days=new Date(y,m+1,0).getDate();
  const tot=dailyTotals(),tIso=todayISO();
  let cells="";
  for(let i=0;i<startDow;i++)cells+=`<div class="cal-cell empty"></div>`;
  for(let d=1;d<=days;d++){
    const iso=`${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`,t=tot[iso],today=iso===tIso;
    cells+=`<div class="cal-cell ${today?"today":""}" data-day="${iso}"><div class="cn">${d}</div>${t?`<span class="cal-cnt">${t.count}</span>${can("dailyTotals")?`<div class="csum">${fmtMXN(t.total)}</div>`:""}`:""}</div>`;
  }
  const monTot=Object.entries(tot).filter(([k])=>k.startsWith(`${y}-${String(m+1).padStart(2,"0")}`)).reduce((s,[,v])=>s+v.total,0);
  $("#content").innerHTML=`
    <div class="cal-top"><div class="cal-nav">
      <button class="cal-ic" id="cprev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M15 18l-6-6 6-6" stroke-linecap="round"/></svg></button>
      <b>${MONTHS[m]} ${y}</b>
      <button class="cal-ic" id="cnext"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 18l6-6-6-6" stroke-linecap="round"/></svg></button></div>
      ${can("monthlyTotals")?`<div class="cal-month-tot">${fmtMXN(monTot)} <span style="font-weight:500;color:var(--faint);font-family:var(--body);font-size:12px">este mes</span></div>`:`<div style="font-size:12px;color:var(--faint)">Total mensual no disponible${fullHistory()?"":" · se muestran los últimos 7 días"}</div>`}</div>
    <div class="cal-grid">${["dom","lun","mar","mié","jue","vie","sáb"].map(d=>`<div class="cal-dow">${d}</div>`).join("")}${cells}</div>
    <div id="cal-detail" style="margin-top:20px"></div>`;
  $("#cprev").onclick=()=>{let nm=m-1,ny=y;if(nm<0){nm=11;ny--;}calMonth=ny+"-"+nm;drawCalendar();};
  $("#cnext").onclick=()=>{let nm=m+1,ny=y;if(nm>11){nm=0;ny++;}calMonth=ny+"-"+nm;drawCalendar();};
  $("#content").querySelectorAll("[data-day]").forEach(c=>c.onclick=()=>showDay(c.dataset.day));
}
function showDay(iso){
  const es=entriesCache.filter(e=>e.entry_date===iso),dt=parseDate(iso),host=$("#cal-detail");
  if(!es.length){host.innerHTML=`<div class="empty" style="padding:34px"><b>${dt.getDate()} ${MONTHS[dt.getMonth()]}</b>Sin entradas este día.</div>`;return;}
  const t=es.reduce((s,e)=>s+entryMXN(e),0);
  host.innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin:0 4px 11px">
    <span class="dd" style="text-transform:capitalize">${DOW[dt.getDay()]} ${dt.getDate()} de ${MONTHS[dt.getMonth()]}</span>
    <span class="dt" style="color:var(--emerald-deep);font-family:var(--display);font-weight:700">${can("dailyTotals")?fmtMXN(t):"—"}</span></div>
    <div class="elist">${es.map(rowHTML).join("")}</div>`;
  bindRows(host);
  host.scrollIntoView({behavior:"smooth",block:"nearest"});
}

/* ---- ENTRY FORM ---- */
let lines=[],editId=null,editFx=null,curView="entries";
$("#btn-new").onclick=()=>openSheet();
$("#sheet-close").onclick=closeSheet;$("#sheet-cancel").onclick=closeSheet;$("#scrim").onclick=closeSheet;
function closeSheet(){$("#scrim").classList.remove("open");$("#sheet").classList.remove("open");}
function openSheet(entry){
  editId=entry?entry.id:null;
  const defM=cats.metodo[0]||"Pesos (MXN)";
  if(entry){
    lines=(entry.entry_items||[]).map(it=>({conceptos:[it.concepto],modificador:it.modificador||"",monto:it.amount,metodo:it.method||entry.method||defM}));
    if(!lines.length)lines=[{conceptos:[cats.concepto[0]||""],modificador:"",monto:"",metodo:defM}];
  }else{
    lines=[{conceptos:[cats.concepto[0]||""],modificador:"",monto:"",metodo:defM}];
  }
  const pname=entry?((entry.patients&&entry.patients.name)||""):"";
  const pphone=entry?((entry.patients&&entry.patients.phone)||""):"";
  editFx=entry&&Number(entry.fx_rate)||me.fx;
  $("#sheet").querySelector(".sheet-head h3").textContent=entry?"Editar entrada":"Nueva entrada";
  const opt=(arr,val)=>arr.map(o=>`<option ${o===val?"selected":""}>${esc(o)}</option>`).join("");
  $("#sheet-body").innerHTML=`
    <div class="frow two">
      <div><label>Paciente</label><input id="i-pac" list="pac-list" placeholder="Nombre del paciente" autocomplete="off" value="${esc(pname)}"><datalist id="pac-list"></datalist></div>
      <div><label>Teléfono</label><input id="i-tel" type="tel" placeholder="Opcional · distingue homónimos" autocomplete="off" value="${esc(pphone)}"></div></div>
    <div class="frow two">
      <div><label>Fecha</label><input id="i-fecha" type="date" value="${entry?entry.entry_date:todayISO()}"></div>
      <div><label>Estatus de pago</label><select id="i-estatus">${opt(withVal(cats.estatus,entry&&entry.status),entry?entry.status:cats.estatus[0])}</select></div></div>
    <div class="frow">
      <div class="svc-head"><label>Cobros</label><button class="svc-add" id="svc-add"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>Agregar línea</button></div>
      <div id="svc-rows"></div>
      <p class="sd" style="font-size:11px;margin:5px 2px 0">Cada línea es un cobro con su método. Un paquete = una línea con varios conceptos (usa “+ concepto”). Pago dividido = una línea por método.</p>
      <div class="svc-total"><span class="stl">Total de la visita (MXN)</span><span class="stv" id="svc-total">$0</span></div></div>
    <div class="frow two" style="margin-top:14px">
      <div><label>N° Factura</label><input id="i-fact" placeholder="Opcional" value="${esc(entry?(entry.invoice_no||""):"")}"></div><div></div></div>
    <div class="frow"><label>Notas</label><textarea id="i-notas" placeholder="Notas administrativas · no registres diagnósticos ni datos clínicos">${esc(entry?(entry.notes||""):"")}</textarea></div>`;
  renderSvc();
  fillPatientList();
  // Picking an existing patient from the suggestions fills in the phone that tells homonyms apart.
  $("#i-pac").addEventListener("change",()=>{const n=$("#i-pac").value.trim().toLowerCase();const hits=(patientsCache||[]).filter(p=>(p.name||"").toLowerCase()===n);if(hits.length===1&&hits[0].phone&&!$("#i-tel").value)$("#i-tel").value=hits[0].phone;});
  $("#svc-add").onclick=()=>{syncSvc();lines.push({conceptos:[cats.concepto[0]||""],modificador:"",monto:"",metodo:defM});renderSvc();};
  $("#scrim").classList.add("open");$("#sheet").classList.add("open");
  setTimeout(()=>$("#i-pac").focus(),120);
}
let patientsCache=null;
async function fillPatientList(){
  if(!patientsCache){const {data}=await fetchAll(()=>sb.from("patients").select("id,name,phone").order("id"));patientsCache=data||[];}
  const dl=$("#pac-list");if(!dl)return;
  dl.innerHTML=patientsCache.filter(p=>p.name&&!/^Paciente eliminado /.test(p.name)).map(p=>`<option value="${esc(p.name)}">${p.phone?esc(p.phone):""}</option>`).join("");
}
function svcRow(it,i){
  const opt=(arr,val)=>arr.map(o=>`<option ${o===val?"selected":""}>${esc(o)}</option>`).join("");
  const cc=it.conceptos.map((c,ci)=>`<div class="cc-row"><select class="cc" style="flex:1">${opt(withVal(cats.concepto,c),c)}</select>${it.conceptos.length>1?`<button class="cc-del" data-i="${i}" data-ci="${ci}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button>`:""}</div>`).join("");
  return `<div class="svc-row">
    <div class="svc-l1">
      <div style="grid-column:1 / 3">${cc}<button class="cc-add" data-i="${i}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>concepto</button></div>
      <button class="svc-del" data-i="${i}" ${lines.length<=1?'style="visibility:hidden"':""}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button></div>
    <div class="svc-l2">
      <select class="sm"><option value="">— mod —</option>${opt(withVal(cats.modificador,it.modificador),it.modificador)}</select>
      <select class="smethod">${opt(withVal(cats.metodo,it.metodo),it.metodo)}</select>
      <input class="sa" type="number" min="0" step="any" placeholder="Monto" value="${it.monto===""||it.monto==null?"":it.monto}"></div></div>`;
}
function renderSvc(){
  const host=$("#svc-rows");host.innerHTML=lines.map(svcRow).join("");
  host.querySelectorAll(".sa").forEach(inp=>inp.oninput=updTotal);
  host.querySelectorAll(".smethod").forEach(s=>s.onchange=updTotal);
  host.querySelectorAll(".cc-add").forEach(b=>b.onclick=()=>{syncSvc();lines[+b.dataset.i].conceptos.push(cats.concepto[0]||"");renderSvc();});
  host.querySelectorAll(".cc-del").forEach(b=>b.onclick=()=>{syncSvc();lines[+b.dataset.i].conceptos.splice(+b.dataset.ci,1);renderSvc();});
  host.querySelectorAll(".svc-del").forEach(b=>b.onclick=()=>{syncSvc();lines.splice(+b.dataset.i,1);if(!lines.length)lines.push({conceptos:[cats.concepto[0]||""],modificador:"",monto:"",metodo:cats.metodo[0]||"Pesos (MXN)"});renderSvc();});
  updTotal();
}
function syncSvc(){$("#svc-rows").querySelectorAll(".svc-row").forEach((row,i)=>{lines[i]={conceptos:[...row.querySelectorAll(".cc")].map(s=>s.value),modificador:row.querySelector(".sm").value,monto:row.querySelector(".sa").value,metodo:row.querySelector(".smethod").value};});}
function updTotal(){
  let t=0,usd=false;
  const fx=editFx||me.fx;
  $("#svc-rows").querySelectorAll(".svc-row").forEach(row=>{const a=Number(row.querySelector(".sa").value)||0,m=row.querySelector(".smethod").value;if(methodCur(m)==="USD"){usd=true;t+=a*fx;}else t+=a;});
  $("#svc-total").innerHTML=usd?`${fmtMXN(t)} <small style="font-size:11px;color:var(--faint);font-weight:500">incluye USD · TC ${fx}</small>`:fmtMXN(t);
}

$("#sheet-save").onclick=async()=>{
  syncSvc();
  const name=$("#i-pac").value.trim();
  if(!name){$("#i-pac").focus();$("#i-pac").style.borderColor="var(--rose)";return;}
  // each line -> one entry_item per concepto, splitting the line's monto evenly (decomposes packages)
  const items=[];
  lines.forEach(l=>{const cs=l.conceptos.filter(Boolean);if(!cs.length)return;const parts=splitCents(l.monto,cs.length);const meth=l.metodo||cats.metodo[0]||"Pesos (MXN)";cs.forEach((c,i)=>items.push({concepto:c,modificador:l.modificador||null,amount:parts[i],method:meth}));});
  if(!items.length){toast("Agrega al menos una línea con concepto",true);return;}
  const save=$("#sheet-save");save.disabled=true;save.textContent="Guardando...";
  try{
    // One server transaction (save_entry in 0004): patient, entry and lines all-or-nothing.
    const {error:se}=await sb.rpc("save_entry",{p_entry_id:editId,p_patient_name:name,p_patient_phone:$("#i-tel").value.trim()||null,
      p_entry_date:$("#i-fecha").value||todayISO(),p_status:$("#i-estatus").value,p_invoice_no:$("#i-fact").value.trim()||null,
      p_notes:$("#i-notas").value.trim()||null,p_items:items});
    if(se){
      if(/ambiguous_patient/.test(se.message)){$("#i-tel").focus();$("#i-tel").style.borderColor="var(--rose)";throw new Error("Hay varios pacientes con ese nombre: agrega su teléfono.");}
      if(/outside window/.test(se.message))throw new Error("Solo puedes registrar o editar entradas de los últimos 7 días.");
      throw se;
    }
    closeSheet();toast(editId?"Entrada actualizada":"Entrada guardada");patientsCache=null;
    curView==="calendar"?renderCalendar():renderEntries();
  }catch(err){toast("Error: "+(err.message||err),true);}
  finally{save.disabled=false;save.textContent="Guardar entrada";}
};

/* ---- ANALYTICS ---- */
async function renderAnalytics(){
  $("#content").innerHTML=`<div class="loading">Cargando analíticas...</div>`;
  const {data,error}=await fetchAll(()=>sb.from("entries").select("id,entry_date,method,fx_rate,patients(name),entry_items(concepto,amount,method,currency)").order("id"));
  if(error){$("#content").innerHTML=`<div class="empty"><b>Error</b>${esc(error.message)}</div>`;return;}
  const es=data||[];
  const total=es.reduce((s,e)=>s+entryMXN(e),0);
  const pac=new Set(es.map(e=>((e.patients&&e.patients.name)||"").toLowerCase()).filter(Boolean)).size;
  const ticket=es.length?total/es.length:0;
  const byC={};es.forEach(e=>(e.entry_items||[]).forEach(it=>{if(it.concepto)byC[it.concepto]=(byC[it.concepto]||0)+itemMXN(e,it);}));
  const byCount={};es.forEach(e=>[...new Set((e.entry_items||[]).map(it=>it.concepto).filter(Boolean))].forEach(c=>byCount[c]=(byCount[c]||0)+1));
  const concepts=Object.entries(byC).sort((a,b)=>b[1]-a[1]).slice(0,8),maxC=Math.max(1,...concepts.map(c=>c[1]));
  const byM={};es.forEach(e=>(e.entry_items||[]).forEach(it=>{const m=itemMethod(e,it);byM[m]=(byM[m]||0)+itemMXN(e,it);}));
  const methods=Object.entries(byM).sort((a,b)=>b[1]-a[1]),mC=["#12A47C","#3E7CC4","#D99A2B","#19C28F","#8E6FC9","#D5536A"];
  const byD={};es.forEach(e=>byD[e.entry_date]=(byD[e.entry_date]||0)+entryMXN(e));
  const dDays=Object.keys(byD).sort().slice(-14),maxD=Math.max(1,...dDays.map(d=>byD[d]));
  const stat=(lab,val,sub,c,ic)=>`<div class="stat"><div class="lab"><span class="ic" style="background:${c}1a;color:${c}">${ic}</span>${lab}</div><div class="val">${val}</div><div class="delta">${sub}</div></div>`;
  $("#content").innerHTML=`
    <div class="grid-stats">
      ${stat("Ingresos totales",fmtMXN(total),es.length+" entradas","#12A47C",'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2v20M17 6H9a3 3 0 0 0 0 6h6a3 3 0 0 1 0 6H6" stroke-linecap="round"/></svg>')}
      ${stat("Pacientes",pac,"únicos","#3E7CC4",'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="8" r="3.2"/><path d="M5 20a7 7 0 0 1 14 0" stroke-linecap="round"/></svg>')}
      ${stat("Ticket promedio",fmtMXN(ticket),"por visita","#D99A2B",'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 7h16v10H4zM4 11h16" stroke-linecap="round"/></svg>')}
      ${stat("Conceptos activos",Object.keys(byC).length,"facturados","#8E6FC9",'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 6h16M4 12h10M4 18h7" stroke-linecap="round"/></svg>')}
    </div>
    <div class="an-grid">
      <div class="panel"><h3>Ingresos por concepto</h3><p class="psub">Top servicios · monto (MXN) y veces realizado</p>
        ${concepts.map(([c,v])=>`<div class="bar-row"><div class="bl">${esc(c)}</div><div class="bar-track"><div class="bar-fill" style="width:${v/maxC*100}%"></div></div><div class="bar-val">${fmtMXN(v)}<span style="display:block;font-weight:500;color:var(--faint);font-size:10px">${byCount[c]||0} ${byCount[c]===1?"vez":"veces"}</span></div></div>`).join("")||'<p class="psub">Sin datos</p>'}</div>
      <div class="panel"><h3>Método de pago</h3><p class="psub">Distribución</p>
        <div class="donut-wrap">${donut(methods,mC,total)}
        <div class="legend">${methods.map(([m,v],i)=>`<div class="li"><span class="sw" style="background:${mC[i%mC.length]}"></span><b>${esc(m)}</b><span>${total?Math.round(v/total*100):0}%</span></div>`).join("")}</div></div></div>
    </div>
    <div class="panel" style="margin-top:18px"><h3>Tendencia diaria</h3><p class="psub">Ingresos por día (últimos)</p>
      <div class="trend">${dDays.map(d=>{const v=byD[d],dd=parseDate(d);return `<div class="tb"><div class="tbar" style="height:${Math.max(4,v/maxD*120)}px" title="${fmtMXN(v)}"></div><small>${dd.getDate()}/${dd.getMonth()+1}</small></div>`;}).join("")||'<p class="psub">Sin datos</p>'}</div></div>`;
}
function donut(methods,colors,total){
  if(!total)return `<svg width="120" height="120" viewBox="0 0 42 42"><circle cx="21" cy="21" r="15.9" fill="none" stroke="var(--line)" stroke-width="6"/></svg>`;
  let off=25,segs="";
  methods.forEach(([m,v],i)=>{const pct=v/total*100;segs+=`<circle cx="21" cy="21" r="15.9" fill="none" stroke="${colors[i%colors.length]}" stroke-width="6" stroke-dasharray="${pct} ${100-pct}" stroke-dashoffset="${off}"/>`;off=(off-pct+100)%100;});
  return `<svg width="120" height="120" viewBox="0 0 42 42" style="transform:rotate(-90deg)">${segs}<circle cx="21" cy="21" r="11" fill="var(--surface)"/></svg>`;
}

/* ---- CRM (Pacientes) ---- */
let crmView="grid", crmRows=[], crmQ="";
const normTxt=s=>String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
function fmtShort(iso){if(!iso)return"—";const d=parseDate(iso);return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)}`;}
async function renderCRM(){
  $("#content").innerHTML=`<div class="loading">Cargando pacientes...</div>`;
  const [{data:pats,error:perr},{data:ents}]=await Promise.all([
    fetchAll(()=>sb.from("patients").select("id,name,phone,created_at").order("id")),
    fetchAll(()=>sb.from("entries").select("id,patient_id,entry_date,method,fx_rate,entry_items(concepto,amount,method,currency)").order("id"))
  ]);
  if(perr){$("#content").innerHTML=`<div class="empty"><b>Error</b>${esc(perr.message)}</div>`;return;}
  const agg={};
  (ents||[]).forEach(e=>{
    const a=agg[e.patient_id]||(agg[e.patient_id]={visits:new Set(),total:0,concepts:new Set(),last:null});
    a.visits.add(e.entry_date);a.total+=entryMXN(e);
    (e.entry_items||[]).forEach(it=>it.concepto&&a.concepts.add(it.concepto));
    if(!a.last||e.entry_date>a.last)a.last=e.entry_date;
  });
  crmRows=(pats||[]).map(p=>{const a=agg[p.id]||{visits:new Set(),total:0,concepts:new Set(),last:null};
    return {id:p.id,name:p.name,phone:p.phone||"",visits:a.visits.size,total:a.total,concepts:[...a.concepts],last:a.last,nuevo:a.visits.size<=1};
  }).sort((x,y)=>(y.last||"").localeCompare(x.last||""));
  drawCRM();
}
function drawCRM(){
  if(!crmRows.length){$("#content").innerHTML=`<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0" stroke-linecap="round"/></svg><b>Sin pacientes</b>Se agregan solos al registrar entradas.</div>`;return;}
  $("#content").innerHTML=`<div class="crm-toolbar"><input id="crm-q" class="crm-search" placeholder="Buscar por nombre o teléfono" autocomplete="off" value="${esc(crmQ)}"><div class="view-toggle" id="crm-toggle">
    <button data-v="grid" class="${crmView==="grid"?"on":""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg></button>
    <button data-v="list" class="${crmView==="list"?"on":""}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 6h16M4 12h16M4 18h16" stroke-linecap="round"/></svg></button></div></div><div id="crm-body"></div>`;
  $("#crm-toggle").querySelectorAll("button").forEach(b=>b.onclick=()=>{crmView=b.dataset.v;$("#crm-toggle").querySelectorAll("button").forEach(x=>x.classList.toggle("on",x===b));drawCRMBody();});
  $("#crm-q").oninput=()=>{crmQ=$("#crm-q").value;drawCRMBody();};
  drawCRMBody();
}
function drawCRMBody(){
  const q=normTxt(crmQ.trim()),rows=q?crmRows.filter(r=>normTxt(r.name).includes(q)||r.phone.replace(/\D/g,"").includes(q.replace(/\D/g,"")||"\u0000")):crmRows;
  const host=$("#crm-body");
  if(!rows.length){host.innerHTML=`<div class="empty" style="padding:40px"><b>Sin resultados</b>Ningún paciente coincide con «${esc(crmQ)}».</div>`;return;}
  let body;
  if(crmView==="grid"){
    body=`<div class="crm-grid">${rows.map(r=>`<div class="pcard" data-p="${r.id}">
      <div class="ph"><div class="pava-lg">${esc(initials(r.name))}</div><div><b>${esc(r.name)} ${r.nuevo?'<span class="badge-new">NUEVO</span>':""}</b><small>${r.phone?esc(r.phone)+" · ":""}${r.last?"Última: "+fmtShort(r.last):"Sin visitas"}</small></div></div>
      <div class="pmeta"><div><div class="k">Visitas</div><div class="v">${r.visits}</div></div><div><div class="k">Total</div><div class="v">${fmtMXN(r.total)}</div></div></div>
      <div class="ptags">${r.concepts.slice(0,4).map(c=>`<span class="tag concept">${esc(c)}</span>`).join("")}${r.concepts.length>4?`<span class="tag mod">+${r.concepts.length-4}</span>`:""}</div></div>`).join("")}</div>`;
  }else{
    body=`<div class="crm-list"><div class="cl-row head"><div>Paciente</div><div>Visitas</div><div>Total</div><div>Última</div><div>Servicios</div></div>
      ${rows.map(r=>`<div class="cl-row" data-p="${r.id}"><div class="cl-name"><span class="pava">${esc(initials(r.name))}</span><span>${esc(r.name)} ${r.nuevo?'<span class="badge-new">NUEVO</span>':""}${r.phone?`<small>${esc(r.phone)}</small>`:""}</span></div>
      <div class="cl-v">${r.visits}</div><div class="cl-v">${fmtMXN(r.total)}</div><div style="color:var(--muted)">${fmtShort(r.last)}</div>
      <div class="cl-tags">${r.concepts.slice(0,3).map(c=>`<span class="tag concept">${esc(c)}</span>`).join("")}${r.concepts.length>3?`<span class="tag mod">+${r.concepts.length-3}</span>`:""}</div></div>`).join("")}</div>`;
  }
  host.innerHTML=body;
  host.querySelectorAll("[data-p]").forEach(el=>el.onclick=()=>openPatient(el.dataset.p));
}
async function openPatient(id){
  const r=crmRows.find(x=>x.id===id);if(!r)return;
  $("#pt-head").innerHTML=`<div class="pava-lg">${esc(initials(r.name))}</div><div><h3>${esc(r.name)}</h3><small>${r.phone?esc(r.phone)+" · ":""}${r.last?"Última visita "+fmtShort(r.last):"Sin visitas"}</small></div>
    <div class="pt-stats"><div class="s"><b>${r.visits}</b><small>visitas</small></div><div class="s"><b>${fmtMXN(r.total)}</b><small>total</small></div></div>
    ${can("deleteEntries")&&!/^Paciente eliminado /.test(r.name)?`<button class="btn subtle" id="pt-anon" style="margin-left:6px;font-size:12.5px;padding:8px 12px" title="Borra nombre y contacto; conserva los cobros de forma anónima">Anonimizar</button>`:""}
    <button class="svc-del" id="pt-close" style="width:34px;height:34px"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button>`;
  $("#pt-body").innerHTML=`<div class="loading">Cargando visitas...</div>`;
  $("#pt-scrim").classList.add("open");$("#pt-modal").classList.add("open");
  $("#pt-close").onclick=closePatient;
  const an=$("#pt-anon");if(an)an.onclick=()=>anonymizePatient(id,r.name);
  const {data:ents}=await sb.from("entries").select("id,entry_date,status,method,card_type,fx_rate,entry_items(concepto,modificador,amount,method,currency)").eq("patient_id",id).order("entry_date",{ascending:false});
  if(!ents||!ents.length){$("#pt-body").innerHTML=`<p style="color:var(--faint)">Sin visitas.</p>`;return;}
  $("#pt-body").innerHTML=ents.map(e=>{const dt=parseDate(e.entry_date);
    return `<div class="pt-visit"><div class="pt-visit-head"><span class="vd">${DOW[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()]}</span><span class="va">${fmtMXN(entryMXN(e))}</span></div>
    <div class="pt-svc">${entryConceptos(e).map(it=>`<span class="tag concept">${esc(it.concepto)}${it.modificador?" · "+esc(it.modificador):""}</span>`).join("")}</div></div>`;
  }).join("");
}
function closePatient(){$("#pt-scrim").classList.remove("open");$("#pt-modal").classList.remove("open");}
$("#pt-scrim").onclick=closePatient;
// ARCO "cancelación" for a patient: strips identity and notes, keeps the fiscal revenue records (0005).
async function anonymizePatient(id,name){
  if(!confirm(`Se borrarán el nombre, teléfono y notas de "${name}". Sus cobros se conservan de forma anónima (obligación fiscal). Esta acción no se puede deshacer. ¿Continuar?`))return;
  const {error}=await sb.rpc("anonymize_patient",{p_patient:id});
  if(error){toast(rpcMissing(error)?"Esta función requiere aplicar la migración 0005 en Supabase.":"Error: "+error.message,true);return;}
  toast("Paciente anonimizado");closePatient();renderCRM();
}

/* ---- SETTINGS ---- */
const CAP_LABELS=[
  ["dailyTotals","Totales diarios","Ver el total de dinero por día en Entradas y Calendario."],
  ["monthlyTotals","Totales mensuales","Ver el total acumulado del mes."],
  ["analytics","Analíticas","Acceso a la pestaña de reportes y gráficas."],
  ["editCategories","Editar categorías","Crear o eliminar conceptos, modificadores y métodos."],
  ["editFx","Ajustar tipo de cambio","Cambiar la tasa USD → MXN."],
  ["exportData","Exportar datos","Descargar el registro en CSV."],
  ["deleteEntries","Eliminar entradas","Borrar entradas (siempre pueden crear)."],
  ["editEntries","Editar entradas","Modificar entradas ya guardadas. Todo cambio queda en el historial."]
];
async function renderSettings(){
  let tabs;
  if(me.role==="manager"){tabs=[["preferencias","Preferencias"],["personal","Personal"],["categorias","Categorías"],["datos","Datos"],["privacidad","Privacidad"],["general","General"]];}
  else{tabs=[];if(can("editCategories"))tabs.push(["categorias","Categorías"]);if(can("editFx")||can("exportData"))tabs.push(["datos","Datos"]);tabs.push(["privacidad","Privacidad"],["general","General"]);}
  if(!tabs.find(t=>t[0]===settingsTab))settingsTab=tabs[0][0];
  $("#content").innerHTML=`<div class="set-tabs">${tabs.map(([k,l])=>`<button data-st="${k}" class="${settingsTab===k?"on":""}">${l}</button>`).join("")}</div><div class="set-panel" id="set-panel"><div class="loading">Cargando...</div></div>`;
  document.querySelectorAll("[data-st]").forEach(b=>b.onclick=()=>{settingsTab=b.dataset.st;renderSettings();});
  if(settingsTab==="preferencias")await setPrefs();
  else if(settingsTab==="personal")await setPersonal();
  else if(settingsTab==="categorias")await setCats();
  else if(settingsTab==="datos")setDatos();
  else if(settingsTab==="privacidad")setPrivacidad();
  else setGeneral();
}
async function setPrefs(){
  const {data}=await sb.from("clinic_settings").select("recepcion_caps").eq("clinic_id",me.clinicId).single();
  const caps=Object.assign({dailyTotals:true,monthlyTotals:false,analytics:false,editCategories:true,editFx:true,exportData:false,deleteEntries:true,editEntries:true},(data&&data.recepcion_caps)||{});
  $("#set-panel").innerHTML=`
    <div class="warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 16v-4M12 8h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z" stroke-linecap="round"/></svg><div>Define qué puede ver y hacer el modo <b>Recepción</b>. El Gerente siempre tiene acceso total.</div></div>
    <div class="set-block"><h3>Capacidades de Recepción</h3><p class="sd">Cada consultorio decide qué mostrar a su recepción.</p>
    ${CAP_LABELS.map(([k,t,d])=>`<div class="pref-row"><div class="pl"><b>${t}</b><small>${d}</small></div><button class="switch ${caps[k]?"on":""}" data-cap="${k}"></button></div>`).join("")}</div>`;
  $("#set-panel").querySelectorAll("[data-cap]").forEach(b=>b.onclick=async()=>{
    caps[b.dataset.cap]=!caps[b.dataset.cap];b.classList.toggle("on",caps[b.dataset.cap]);
    const {error}=await sb.rpc("set_recepcion_caps",{p_caps:caps});
    toast(error?"Error al guardar":"Preferencia guardada",!!error);
  });
}
async function setCats(){
  const {data}=await sb.from("categories").select("id,kind,label,currency").eq("clinic_id",me.clinicId).order("sort_order");
  const groups={concepto:[],modificador:[],estatus:[],metodo:[],tipo_tarjeta:[]};(data||[]).forEach(r=>{if(groups[r.kind])groups[r.kind].push(r);});
  const meta=[["concepto","Conceptos / Servicios"],["modificador","Modificadores"],["estatus","Estatus de pago"],["metodo","Métodos de pago"],["tipo_tarjeta","Tipos de tarjeta"]];
  $("#set-panel").innerHTML=meta.map(([kind,title])=>`
    <div class="set-block"><h3>${title}</h3>
      <div class="chips">${groups[kind].map(r=>`<span class="chip">${esc(r.label)}${kind==="metodo"?`<button data-cur="${r.id}" data-to="${r.currency==="USD"?"MXN":"USD"}" title="Moneda (toca para cambiar)" style="width:auto;padding:0 6px;font-size:10px;font-weight:700">${r.currency}</button>`:""}<button data-del="${r.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg></button></span>`).join("")||'<span class="sd">Vacío</span>'}</div>
      <div class="add-cat"><input id="add-${kind}" placeholder="Agregar..."><button class="btn solid" data-add="${kind}">Agregar</button></div></div>`).join("");
  $("#set-panel").querySelectorAll("[data-cur]").forEach(b=>b.onclick=async()=>{const {error}=await sb.from("categories").update({currency:b.dataset.to}).eq("id",b.dataset.cur);if(error){toast("Error: "+error.message,true);return;}await loadCats();setCats();});
  $("#set-panel").querySelectorAll("[data-del]").forEach(b=>b.onclick=async()=>{const {error}=await sb.from("categories").delete().eq("id",b.dataset.del);if(error){toast("Error: "+error.message,true);return;}await loadCats();setCats();});
  const add=async kind=>{const inp=$("#add-"+kind),v=inp.value.trim();if(!v)return;const {error}=await sb.from("categories").insert({clinic_id:me.clinicId,kind,label:v,sort_order:groups[kind].length});if(error){toast("Error: "+error.message,true);return;}await loadCats();setCats();toast("Agregado");};
  $("#set-panel").querySelectorAll("[data-add]").forEach(b=>b.onclick=()=>add(b.dataset.add));
  $("#set-panel").querySelectorAll(".add-cat input").forEach(inp=>inp.onkeydown=e=>{if(e.key==="Enter")add(inp.id.replace("add-",""));});
}
function setDatos(){
  const showFx=me.role==="manager"||can("editFx");
  const showExp=me.role==="manager"||can("exportData");
  $("#set-panel").innerHTML=`
    ${showFx?`<div class="set-block"><h3>Tipo de cambio</h3><p class="sd">USD → MXN. Convierte montos en dólares automáticamente.</p>
      <div class="set-row"><div class="srl"><b>1 USD =</b></div><input class="mini-input" id="s-fx" type="number" step="0.01" value="${me.fx}"></div>
      <div style="margin-top:14px"><button class="btn solid" id="s-fx-save">Guardar TC</button></div></div>`:""}
    ${showExp?`<div class="set-block"><h3>Exportar</h3><p class="sd">Descarga todas las entradas en CSV.</p>
      <button class="btn solid" id="exp-csv"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16" stroke-linecap="round"/></svg>Exportar CSV</button></div>`:""}
    ${me.role==="manager"?`<div class="set-block"><h3>Historial de cambios</h3><p class="sd">Últimos 50 movimientos en entradas y cobros: quién y cuándo.</p><div id="audit-list"><div class="loading">Cargando...</div></div></div>`:""}`;
  if(me.role==="manager")loadAudit();
  if(showFx)$("#s-fx-save").onclick=async()=>{const v=Number($("#s-fx").value);if(!(v>0&&v<1000)){toast("Tipo de cambio inválido",true);return;}const {error}=await sb.rpc("set_fx_rate",{p_rate:v});if(error){toast("Error al guardar",true);return;}me.fx=v;toast("TC actualizado · "+v);};
  if(showExp)$("#exp-csv").onclick=exportCSV;
}
async function loadAudit(){
  const {data,error}=await sb.from("entry_audit").select("table_name,action,at,old_data,new_data,profiles(display_name)").order("at",{ascending:false}).limit(50);
  const host=$("#audit-list");if(!host)return;
  if(error){host.innerHTML=`<p class="sd">${esc(error.message)}</p>`;return;}
  if(!data.length){host.innerHTML='<p class="sd">Sin movimientos.</p>';return;}
  const ACT={insert:"creó",update:"editó",delete:"eliminó"};
  host.innerHTML=data.map(a=>{const r=a.new_data||a.old_data||{};
    const what=a.table_name==="entries"?`entrada del ${esc(r.entry_date||"")}`:`cobro ${esc(r.concepto||"")} · ${esc(r.amount)} ${esc(r.currency||"")}`;
    const when=new Date(a.at).toLocaleString("es-MX",{dateStyle:"short",timeStyle:"short"});
    return `<div class="set-row"><div class="srl"><b>${esc((a.profiles&&a.profiles.display_name)||"—")} ${ACT[a.action]||esc(a.action)} ${what}</b><small>${esc(when)}</small></div></div>`;}).join("");
}
function setGeneral(){
  $("#set-panel").innerHTML=`
    <div class="set-block"><h3>Sesión</h3>
      <div class="set-row"><div class="srl"><b>Cerrar sesión</b><small>Vuelve a la pantalla de inicio.</small></div>
        <button class="btn" id="s-logout" style="background:#fff;border:1px solid #F0D2D8;color:var(--rose)">Cerrar sesión</button></div></div>
    <div class="set-block"><h3>Privacidad y datos</h3>
      <p class="sd" style="line-height:1.6">La información se guarda con acceso por usuario y consultorio; ningún otro consultorio puede verla. La sesión se cierra sola tras 30 minutos sin actividad. Documentos legales, descarga de tus datos y eliminación de cuenta: pestaña <b>Privacidad</b>.</p></div>
    <div class="set-block"><h3>Estado del sistema</h3><p class="sd">Qué tiene aplicado la base de datos. Si algo marca «falta», ejecuta ese archivo en Supabase → SQL Editor, en orden.</p><div id="sys-diag"><div class="loading" style="padding:18px">Comprobando...</div></div></div>
    <div class="set-block"><h3>Acerca de</h3><p class="sd">Praxia · Registro · versión ${esc(APP_VERSION)} · entorno ${esc(CFG.env||"production")}</p></div>`;
  $("#s-logout").onclick=async()=>{if(confirm("¿Cerrar sesión?")){await sb.auth.signOut();location.reload();}};
  loadDiag();
}
// Probes one object per migration; "missing" errors (no such column/table/function) mean it was never applied.
async function loadDiag(){
  const host=$("#sys-diag");if(!host)return;
  const missing=e=>!!e&&(e.code==="42703"||e.code==="42P01"||e.code==="PGRST202"||e.code==="42883");
  const probes=[
    ["0004_security_fixes.sql","Cobros por línea, historial de cambios y tipo de cambio congelado",async()=>!missing((await sb.from("categories").select("currency").limit(1)).error)],
    ["0005_privacy_compliance.sql","Consentimiento, anonimización y descarga de datos",async()=>!missing((await sb.from("privacy_log").select("id",{count:"exact",head:true})).error)],
    ["0006_accounts.sql","Altas de cuenta, equipo e invitaciones",async()=>!missing((await sb.rpc("check_invite",{p_code:"0000000000000000"})).error)],
    ["0007_observability.sql","Reporte de errores a Praxia",async()=>!missing((await sb.from("client_errors").select("id",{count:"exact",head:true})).error)]];
  const rows=[];for(const [f,what,fn] of probes){let ok;try{ok=await fn();}catch(_){ok=false;}rows.push([f,what,ok]);}
  const catsInfo=`${cats.concepto.length} conceptos · ${cats.modificador.length} modificadores · ${cats.metodo.length} métodos · ${cats.estatus.length} estatus`+(cats.fallback&&cats.fallback.length?" · predeterminados (no se pudieron leer de la base: "+esc(cats.loadError||"")+")":"");
  if(!$("#sys-diag"))return;
  host.innerHTML=`<div class="set-row"><div class="srl"><b>Categorías del formulario</b><small>${catsInfo}</small></div><span class="pill ${cats.fallback&&cats.fallback.length?"warn":"ok"}">${cats.fallback&&cats.fallback.length?"revisar":"ok"}</span></div>`
    +rows.map(([f,what,ok])=>`<div class="set-row"><div class="srl"><b>${esc(f)}</b><small>${esc(what)}</small></div><span class="pill ${ok?"ok":"off"}">${ok?"aplicada":"falta"}</span></div>`).join("");
}
/* ---- PRIVACY (ARCO) ---- */
function setPrivacidad(){
  const mail=LEGAL.correoPrivacidad&&!/^\[/.test(LEGAL.correoPrivacidad)?LEGAL.correoPrivacidad:"";
  const tpl=`aviso-pacientes.html?consultorio=${encodeURIComponent(me.clinicName||"")}&responsable=${encodeURIComponent(me.displayName||"")}`;
  $("#set-panel").innerHTML=`
    <div class="set-block"><h3>Documentos legales</h3><p class="sd">Versión vigente: ${esc(TERMS_VERSION)}.</p>
      <div class="set-row"><div class="srl"><b>Aviso de privacidad de Praxia</b><small>Cómo tratamos los datos de las personas usuarias.</small></div><a class="btn subtle" href="privacidad.html" target="_blank" rel="noopener">Abrir</a></div>
      <div class="set-row"><div class="srl"><b>Términos del servicio</b><small>Incluye las condiciones de tratamiento de datos por cuenta del consultorio.</small></div><a class="btn subtle" href="terminos.html" target="_blank" rel="noopener">Abrir</a></div>
      <div class="set-row"><div class="srl"><b>Aviso de privacidad para tus pacientes</b><small>Plantilla con el nombre de tu consultorio ya puesto. Imprímela y recaba la firma de cada paciente.</small></div><a class="btn subtle" href="${esc(tpl)}" target="_blank" rel="noopener">Abrir</a></div></div>
    <div class="set-block"><h3>Tus derechos (ARCO)</h3><p class="sd">Acceso, rectificación, cancelación y oposición. Tu nombre se cambia desde tu perfil; lo demás, aquí${mail?` o escribiendo a <a href="mailto:${esc(mail)}">${esc(mail)}</a>`:""}.</p>
      <div class="set-row"><div class="srl"><b>Descargar mis datos</b><small>Archivo JSON con lo que Praxia guarda sobre tu cuenta.</small></div><button class="btn subtle" id="pv-export">Descargar</button></div>
      <div class="set-row"><div class="srl"><b>Eliminar mi cuenta</b><small>Borra tu acceso y tu perfil.${me.role==="manager"?" Si eres el único gerente y el consultorio tiene datos, primero elimina el consultorio o invita a otro gerente.":""}</small></div><button class="btn danger" id="pv-delme">Eliminar</button></div></div>
    ${me.role==="manager"?`<div class="set-block"><h3>Consultorio</h3><p class="sd">Acciones del gerente sobre todos los datos del consultorio.</p>
      <div class="set-row"><div class="srl"><b>Exportar todo el registro</b><small>CSV con todas las entradas y pacientes.</small></div><button class="btn subtle" id="pv-csv">Exportar CSV</button></div>
      <div class="set-row"><div class="srl"><b>Eliminar el consultorio y todos sus datos</b><small>Pacientes, entradas, categorías, invitaciones e historial. El personal conserva su cuenta pero queda fuera del consultorio. No se puede deshacer.</small></div><button class="btn danger" id="pv-delclinic">Eliminar consultorio</button></div></div>
    <div class="set-block"><h3>Registro de privacidad</h3><p class="sd">Consentimientos, anonimizaciones y eliminaciones en este consultorio.</p><div id="pv-log"><div class="loading">Cargando...</div></div></div>`:""}`;
  $("#pv-export").onclick=exportMyData;
  $("#pv-delme").onclick=deleteMyAccount;
  if(me.role==="manager"){$("#pv-csv").onclick=exportCSV;$("#pv-delclinic").onclick=deleteClinic;loadPrivacyLog();}
}
const needs0005=e=>rpcMissing(e)?"Esta función requiere aplicar la migración 0005 en Supabase.":null;
async function exportMyData(){
  const {data,error}=await sb.rpc("export_my_data");
  if(error){toast(needs0005(error)||"Error: "+error.message,true);return;}
  const b=new Blob([JSON.stringify(data,null,2)],{type:"application/json"}),u=URL.createObjectURL(b),a=document.createElement("a");a.href=u;a.download="mis-datos-praxia.json";a.click();URL.revokeObjectURL(u);toast("Datos descargados");
}
async function deleteMyAccount(){
  if(prompt("Esta acción borra tu cuenta y no se puede deshacer. Escribe ELIMINAR para confirmar:")!=="ELIMINAR")return;
  const {error}=await sb.rpc("delete_my_account");
  if(error){toast(needs0005(error)||(/delete_clinic_first/.test(error.message)?"Eres el único gerente: primero elimina el consultorio o invita a otro gerente.":"Error: "+error.message),true);return;}
  await sb.auth.signOut();location.reload();
}
async function deleteClinic(){
  const typed=prompt(`Se borrarán TODOS los datos de "${me.clinicName}". Exporta el CSV antes si lo necesitas. Escribe el nombre exacto del consultorio para confirmar:`);
  if(typed==null)return;
  const {error}=await sb.rpc("delete_clinic",{p_confirm_name:typed});
  if(error){toast(needs0005(error)||(/confirm_name_mismatch/.test(error.message)?"El nombre no coincide.":"Error: "+error.message),true);return;}
  await sb.auth.signOut();location.reload();
}
async function loadPrivacyLog(){
  const host=$("#pv-log");if(!host)return;
  const {data,error}=await sb.from("privacy_log").select("action,at,actor_name,details").order("at",{ascending:false}).limit(50);
  if(error){host.innerHTML=`<p class="sd">${rpcMissing(error)?"Disponible al aplicar la migración 0005.":esc(error.message)}</p>`;return;}
  if(!data.length){host.innerHTML='<p class="sd">Sin eventos.</p>';return;}
  const T={terms_accepted:"aceptó el Aviso y los Términos",patient_anonymized:"anonimizó a un paciente",account_deleted:"eliminó su cuenta",clinic_deleted:"eliminó el consultorio"};
  host.innerHTML=data.map(l=>`<div class="set-row"><div class="srl"><b>${esc(l.actor_name||"—")} ${T[l.action]||esc(l.action)}${l.action==="terms_accepted"&&l.details&&l.details.version?" · v"+esc(l.details.version):""}</b><small>${esc(new Date(l.at).toLocaleString("es-MX",{dateStyle:"short",timeStyle:"short"}))}</small></div></div>`).join("");
}
/* ---- TEAM (Personal) — list_members / remove / role / status / invites (0006) ---- */
const rolePill=r=>`<span class="pill ${r==="manager"?"ok":"info"}">${r==="manager"?"Gerente":"Recepción"}</span>`;
const statusPill=s=>({active:'<span class="pill ok">Activo</span>',disabled:'<span class="pill off">Deshabilitado</span>',needs_clinic:'<span class="pill warn">Sin consultorio</span>',pending_email:'<span class="pill warn">Sin confirmar</span>',no_profile:'<span class="pill warn">Sin perfil</span>'})[s]||`<span class="pill">${esc(s)}</span>`;
const fmtWhen=iso=>iso?new Date(iso).toLocaleString("es-MX",{dateStyle:"short",timeStyle:"short"}):"—";
async function memberAction(fn,args,okMsg,after){
  const {error}=await sb.rpc(fn,args);
  if(error){toast(rpcMissing(error)?"Requiere aplicar la migración 0006 en Supabase.":errText(error),true);return;}
  toast(okMsg);if(after)after();
}
async function setPersonal(){
  const {data,error}=await sb.rpc("list_members");
  if(error){if(rpcMissing(error))return setPersonalLegacy();$("#set-panel").innerHTML=`<p class="sd">${esc(errText(error))}</p>`;return;}
  const mem=(data&&data.members)||[],inv=(data&&data.invites)||[];
  $("#set-panel").innerHTML=`
    <div class="set-block"><h3>Equipo</h3><p class="sd">Quién tiene acceso a este consultorio. El propietario solo lo puede cambiar un administrador de Praxia.</p>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>Persona</th><th>Rol</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>
      ${mem.map(u=>`<tr><td><b>${esc(u.display_name||"Usuario")}</b>${u.is_me?' <span class="pill">tú</span>':""}${u.is_owner?' <span class="pill adm">propietario</span>':""}<small>desde ${esc(fmtWhen(u.joined_at))}</small></td>
        <td>${rolePill(u.role)}</td><td>${statusPill(u.status)}</td>
        <td><div class="acts">${u.is_me||u.is_owner?'<span class="sd">—</span>':`
          <button class="btn subtle mini" data-role="${u.id}" data-to="${u.role==="manager"?"recepcion":"manager"}">${u.role==="manager"?"Hacer recepción":"Hacer gerente"}</button>
          <button class="btn subtle mini" data-status="${u.id}" data-to="${u.status==="disabled"?"active":"disabled"}">${u.status==="disabled"?"Activar":"Deshabilitar"}</button>
          <button class="btn danger mini" data-remove="${u.id}" data-name="${esc(u.display_name||"esta persona")}">Quitar</button>`}</div></td></tr>`).join("")}
      </tbody></table></div></div>
    <div class="set-block"><h3>Invitaciones</h3><p class="sd">Genera un código y compártelo. La persona lo usa en «Únete con un código». Vence en 7 días; si escribes su correo, solo ese correo podrá usarlo.</p>
      <div class="add-cat" style="flex-wrap:wrap"><select id="inv-role" class="mini-input" style="width:auto"><option value="recepcion">Recepción</option><option value="manager">Gerente</option></select><input id="inv-email" type="email" placeholder="Correo (opcional)"><button class="btn solid" id="gen-code">Generar código</button></div>
      <div id="code-out" style="margin-top:14px"></div>
      ${inv.length?`<div class="tblwrap" style="margin-top:14px"><table class="tbl"><thead><tr><th>Código</th><th>Rol</th><th>Para</th><th>Estado</th><th></th></tr></thead><tbody>
        ${inv.map(i=>`<tr><td style="font-family:var(--display);letter-spacing:.1em">${esc(fmtCode(i.code))}</td><td>${rolePill(i.role)}</td><td>${esc(i.email||"cualquiera")}</td>
          <td>${i.reserved?'<span class="pill info">en uso (esperando confirmación)</span>':i.expired?'<span class="pill off">vencido</span>':`<span class="pill ok">vence ${esc(fmtWhen(i.expires_at))}</span>`}</td>
          <td><button class="btn danger mini" data-revoke="${esc(i.code)}">Revocar</button></td></tr>`).join("")}</tbody></table></div>`:'<p class="sd" style="margin-top:12px">Sin invitaciones pendientes.</p>'}</div>`;
  const P=$("#set-panel");
  P.querySelectorAll("[data-role]").forEach(b=>b.onclick=()=>memberAction("set_member_role",{p_uid:b.dataset.role,p_role:b.dataset.to},"Rol actualizado",setPersonal));
  P.querySelectorAll("[data-status]").forEach(b=>b.onclick=()=>memberAction("set_member_status",{p_uid:b.dataset.status,p_status:b.dataset.to},b.dataset.to==="disabled"?"Acceso deshabilitado":"Acceso activado",setPersonal));
  P.querySelectorAll("[data-remove]").forEach(b=>b.onclick=()=>{if(confirm(`¿Quitar a ${b.dataset.name} del consultorio? Conserva su cuenta pero ya no verá nada de aquí.`))memberAction("remove_member",{p_uid:b.dataset.remove},"Persona quitada del consultorio",setPersonal);});
  P.querySelectorAll("[data-revoke]").forEach(b=>b.onclick=()=>memberAction("revoke_invite",{p_code:b.dataset.revoke},"Invitación revocada",setPersonal));
  $("#gen-code").onclick=async()=>{
    const role=$("#inv-role").value,email=$("#inv-email").value.trim()||null;
    const {data:code,error}=await sb.rpc("create_invite",{p_role:role,p_email:email});
    if(error){toast(errText(error),true);return;}
    await setPersonal();
    $("#code-out").innerHTML=`<div class="warn" style="background:rgba(18,164,124,.08);border-color:rgba(18,164,124,.3);color:var(--emerald-deep)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg><div>Código: <b style="font-family:var(--display);letter-spacing:.15em;font-size:16px">${esc(fmtCode(code))}</b> — para ${role==="manager"?"Gerente":"Recepción"}${email?` (solo ${esc(email)})`:""}. Válido una vez, vence en 7 días.</div></div>`;
  };
}

/* ---- PLATFORM ADMIN ---- */
let adminTab="clinics",adminSearch="";
async function renderAdmin(){
  const tabs=[["clinics","Consultorios"],["users","Usuarios"],["new","Nuevo consultorio"],["errors","Errores"]];
  const banner=me.status==="admin_only"?`<div class="warn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 16v-4M12 8h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z" stroke-linecap="round"/></svg><div>Entraste como administrador de Praxia. No perteneces a ningún consultorio: <a id="adm-own" style="cursor:pointer;font-weight:700">crear el mío o unirme con un código</a>.</div></div>`:"";
  $("#content").innerHTML=`${banner}<div class="set-tabs">${tabs.map(([k,l])=>`<button data-at="${k}" class="${adminTab===k?"on":""}">${l}</button>`).join("")}</div><div id="adm-panel"><div class="loading">Cargando...</div></div>`;
  document.querySelectorAll("[data-at]").forEach(b=>b.onclick=()=>{adminTab=b.dataset.at;renderAdmin();});
  const own=$("#adm-own");if(own)own.onclick=()=>showOnboarding(Object.assign({},me.lastState,{pending:{}}),me.user);
  if(adminTab==="clinics")await adminClinics();else if(adminTab==="users")await adminUsers();else if(adminTab==="errors")await adminErrors();else adminNewClinic();
}
async function adminErrors(){
  const host=$("#adm-panel");const {data,error}=await sb.rpc("admin_list_client_errors",{p_limit:100});
  if(error||data===null){host.innerHTML=`<p class="sd">${esc(error?(rpcMissing(error)?"Requiere aplicar la migración 0007 en Supabase.":errText(error)):"Sin permiso.")}</p>`;return;}
  if(!data.length){host.innerHTML='<p class="sd">Sin errores reportados en los últimos 90 días.</p>';return;}
  host.innerHTML=`<p class="sd" style="margin-bottom:12px">Errores de JavaScript no controlados que vieron los usuarios (últimos 100). Versión actual: ${esc(APP_VERSION)}.</p>
    <div class="tblwrap"><table class="tbl"><thead><tr><th>Cuándo</th><th>Error</th><th>Quién</th><th>Versión</th></tr></thead><tbody>
    ${data.map(x=>`<tr><td style="white-space:nowrap">${esc(fmtWhen(x.at))}</td><td><b>${esc(x.message)}</b><small>${esc((x.url||"")+(x.stack?" · "+String(x.stack).split("\n").slice(0,2).join(" ← "):""))}</small></td>
      <td>${esc(x.email||"—")}<small>${esc(x.clinic_name||"")}</small></td><td>${esc(x.app_version||"—")}<small>${esc((x.user_agent||"").slice(0,60))}</small></td></tr>`).join("")}
    </tbody></table></div>`;
}
function showCodeBox(host,code,role,clinicName){
  host.innerHTML=`<div class="warn" style="background:rgba(18,164,124,.08);border-color:rgba(18,164,124,.3);color:var(--emerald-deep)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg><div>Código de <b>${role==="manager"?"Gerente":"Recepción"}</b> para <b>${esc(clinicName)}</b>: <b style="font-family:var(--display);letter-spacing:.15em;font-size:16px">${esc(fmtCode(code))}</b> — la persona lo usa en «Únete con un código». Válido una vez, vence en 7 días.</div></div>`;
}
async function adminClinics(){
  const host=$("#adm-panel");const {data,error}=await sb.rpc("admin_list_clinics");
  if(error||data===null){host.innerHTML=`<p class="sd">${esc(error?(rpcMissing(error)?"Requiere aplicar la migración 0006 en Supabase.":errText(error)):"Sin permiso.")}</p>`;return;}
  host.innerHTML=`<div id="adm-code" style="margin-bottom:14px"></div><div class="tblwrap"><table class="tbl"><thead><tr><th>Consultorio</th><th>Estado</th><th>Miembros</th><th>Entradas</th><th>Acciones</th></tr></thead><tbody>
    ${data.map(c=>`<tr><td><b>${esc(c.name)}</b><small>${esc(c.owner?"Propietario: "+c.owner:"Sin propietario")} · creado ${esc(fmtWhen(c.created_at))}</small></td>
      <td>${c.status==="active"?'<span class="pill ok">Activo</span>':'<span class="pill off">Suspendido</span>'}</td>
      <td>${c.members}${c.open_invites?`<small>${c.open_invites} invitación(es) abierta(s)</small>`:""}</td><td>${c.entries}<small>${c.last_entry?"última "+esc(c.last_entry):"—"}</small></td>
      <td><div class="acts"><button class="btn subtle mini" data-inv="${c.id}" data-role="manager" data-name="${esc(c.name)}">Código gerente</button><button class="btn subtle mini" data-inv="${c.id}" data-role="recepcion" data-name="${esc(c.name)}">Código recepción</button>
        <button class="btn subtle mini" data-cstatus="${c.id}" data-to="${c.status==="active"?"suspended":"active"}">${c.status==="active"?"Suspender":"Activar"}</button>
        <button class="btn danger mini" data-cdel="${c.id}" data-name="${esc(c.name)}">Eliminar</button></div></td></tr>`).join("")||'<tr><td colspan="5" class="sd">Sin consultorios.</td></tr>'}
  </tbody></table></div>`;
  host.querySelectorAll("[data-inv]").forEach(b=>b.onclick=async()=>{const {data:code,error}=await sb.rpc("admin_create_invite",{p_clinic:b.dataset.inv,p_role:b.dataset.role});if(error){toast(errText(error),true);return;}showCodeBox($("#adm-code"),code,b.dataset.role,b.dataset.name);});
  host.querySelectorAll("[data-cstatus]").forEach(b=>b.onclick=()=>memberAction("admin_set_clinic_status",{p_clinic:b.dataset.cstatus,p_status:b.dataset.to},b.dataset.to==="suspended"?"Consultorio suspendido":"Consultorio activado",adminClinics));
  host.querySelectorAll("[data-cdel]").forEach(b=>b.onclick=()=>{if(prompt(`Se borrarán TODOS los datos de "${b.dataset.name}" (pacientes, entradas, historial). Escribe ELIMINAR para confirmar:`)==="ELIMINAR")memberAction("admin_delete_clinic",{p_clinic:b.dataset.cdel},"Consultorio eliminado",adminClinics);});
}
async function adminUsers(){
  const host=$("#adm-panel");
  host.innerHTML=`<div class="adm-search"><input id="adm-q" placeholder="Buscar por correo, nombre o consultorio" value="${esc(adminSearch)}"><button class="btn solid" id="adm-go">Buscar</button></div><div id="adm-users"><div class="loading">Cargando...</div></div>`;
  const load=async()=>{
    const {data,error}=await sb.rpc("admin_list_users",{p_search:adminSearch||null});const u=$("#adm-users");
    if(error||data===null){u.innerHTML=`<p class="sd">${esc(error?(rpcMissing(error)?"Requiere aplicar la migración 0006 en Supabase.":errText(error)):"Sin permiso.")}</p>`;return;}
    u.innerHTML=`<div class="tblwrap"><table class="tbl"><thead><tr><th>Usuario</th><th>Consultorio</th><th>Rol</th><th>Estado</th><th>Acciones</th></tr></thead><tbody>
      ${data.map(x=>`<tr><td><b>${esc(x.display_name||"—")}</b>${x.is_admin?' <span class="pill adm">admin</span>':""}${x.id===me.user.id?' <span class="pill">tú</span>':""}<small>${esc(x.email)} · alta ${esc(fmtWhen(x.created_at))}${x.email_confirmed?"":" · <b>sin confirmar</b>"}${x.last_sign_in_at?" · último acceso "+esc(fmtWhen(x.last_sign_in_at)):""}</small>${x.onboarding_error?`<small style="color:var(--rose)">Alta pendiente: ${esc(errText({message:x.onboarding_error}))}</small>`:""}</td>
        <td>${esc(x.clinic_name||"—")}</td><td>${x.clinic_id?rolePill(x.role):"—"}</td><td>${statusPill(x.status)}</td>
        <td><div class="acts">${x.clinic_id&&x.id!==me.user.id?`<button class="btn subtle mini" data-role="${x.id}" data-to="${x.role==="manager"?"recepcion":"manager"}">${x.role==="manager"?"Hacer recepción":"Hacer gerente"}</button>
          <button class="btn subtle mini" data-status="${x.id}" data-to="${x.status==="disabled"?"active":"disabled"}">${x.status==="disabled"?"Activar":"Deshabilitar"}</button>
          <button class="btn subtle mini" data-remove="${x.id}" data-name="${esc(x.display_name||x.email)}">Quitar del consultorio</button>`:""}
          ${x.id!==me.user.id?`<button class="btn danger mini" data-udel="${x.id}" data-name="${esc(x.email)}">Eliminar cuenta</button>`:""}</div></td></tr>`).join("")||'<tr><td colspan="5" class="sd">Sin resultados.</td></tr>'}
    </tbody></table></div>`;
    u.querySelectorAll("[data-role]").forEach(b=>b.onclick=()=>memberAction("set_member_role",{p_uid:b.dataset.role,p_role:b.dataset.to},"Rol actualizado",load));
    u.querySelectorAll("[data-status]").forEach(b=>b.onclick=()=>memberAction("set_member_status",{p_uid:b.dataset.status,p_status:b.dataset.to},"Estado actualizado",load));
    u.querySelectorAll("[data-remove]").forEach(b=>b.onclick=()=>{if(confirm(`¿Quitar a ${b.dataset.name} de su consultorio?`))memberAction("remove_member",{p_uid:b.dataset.remove},"Quitado del consultorio",load);});
    u.querySelectorAll("[data-udel]").forEach(b=>b.onclick=()=>{if(prompt(`Se borrará la cuenta ${b.dataset.name}. Escribe ELIMINAR para confirmar:`)==="ELIMINAR")memberAction("admin_delete_user",{p_uid:b.dataset.udel},"Cuenta eliminada",load);});
  };
  $("#adm-go").onclick=()=>{adminSearch=$("#adm-q").value.trim();load();};
  $("#adm-q").onkeydown=e=>{if(e.key==="Enter"){adminSearch=$("#adm-q").value.trim();load();}};
  await load();
}
function adminNewClinic(){
  const host=$("#adm-panel");
  host.innerHTML=`<div class="set-block" style="max-width:560px"><h3>Crear consultorio para un cliente</h3><p class="sd">Se crea el consultorio y un código de <b>gerente</b> para entregarle al médico. Al usarlo en «Únete con un código» queda como gerente de su consultorio.</p>
    <div class="add-cat"><input id="adm-cname" placeholder="Nombre del consultorio"><button class="btn solid" id="adm-create">Crear</button></div><div id="adm-newcode" style="margin-top:14px"></div></div>`;
  $("#adm-create").onclick=async()=>{const name=$("#adm-cname").value.trim();if(!name){toast("Escribe el nombre",true);return;}
    const {data,error}=await sb.rpc("admin_create_clinic",{p_name:name});if(error){toast(rpcMissing(error)?"Requiere aplicar la migración 0006 en Supabase.":errText(error),true);return;}
    showCodeBox($("#adm-newcode"),data.invite_code,"manager",name);$("#adm-cname").value="";};
}

// Before 0006: the old read-only team list.
async function setPersonalLegacy(){
  const {data:team}=await sb.from("profiles").select("display_name,role").eq("clinic_id",me.clinicId);
  const {data:codes}=await sb.from("invites").select("code,role,used_at,created_at").is("used_at",null).gt("expires_at",new Date().toISOString()).order("created_at",{ascending:false});
  $("#set-panel").innerHTML=`
    <div class="set-block"><h3>Invitar a recepción</h3><p class="sd">Genera un código y compártelo. Tu recepción lo usa al registrarse para unirse a tu consultorio.</p>
      <button class="btn solid" id="gen-code"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14" stroke-linecap="round"/></svg>Generar código</button>
      <div id="code-out" style="margin-top:14px"></div>
      ${(codes&&codes.length)?`<div class="sd" style="margin-top:16px;margin-bottom:8px">Códigos sin usar:</div><div class="chips">${codes.map(c=>`<span class="chip" style="letter-spacing:.15em;font-family:var(--display)">${esc(c.code.replace(/(.{4})(?=.)/g,"$1-"))}</span>`).join("")}</div>`:""}
    </div>
    <div class="set-block"><h3>Equipo</h3><p class="sd">Quién tiene acceso a este consultorio.</p>
      ${(team||[]).map(t=>`<div class="set-row"><div class="srl"><b>${esc(t.display_name||"Usuario")}</b></div><span class="role-badge ${t.role==="manager"?"mgr":"rec"}">${t.role==="manager"?"Gerente":"Recepción"}</span></div>`).join("")}</div>`;
  $("#gen-code").onclick=async()=>{
    const {data,error}=await sb.rpc("create_invite",{p_role:"recepcion"});
    if(error){toast("Error: "+error.message,true);return;}
    await setPersonalLegacy();
    const shown=String(data).replace(/(.{4})(?=.)/g,"$1-");
    $("#code-out").innerHTML=`<div class="warn" style="background:rgba(18,164,124,.08);border-color:rgba(18,164,124,.3);color:var(--emerald-deep)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg><div>Código: <b style="font-family:var(--display);letter-spacing:.15em;font-size:16px">${esc(shown)}</b> — compártelo con tu recepción. Válido una vez, vence en 48 horas.</div></div>`;
  };
}
async function exportCSV(){
  const {data,error}=await fetchAll(()=>sb.from("entries").select("id,entry_date,status,method,card_type,invoice_no,notes,fx_rate,patients(name,phone),entry_items(concepto,modificador,amount,method,currency)").order("entry_date").order("id"));
  if(error){toast("Error: "+error.message,true);return;}
  const head=["Fecha","Paciente","Telefono","Estatus","Metodo","Moneda","TipoTarjeta","Concepto","Modificador","Monto","TC","MontoMXN","Factura","Notas"];
  const rows=[];(data||[]).forEach(e=>{(e.entry_items||[]).forEach(it=>rows.push([e.entry_date,(e.patients&&e.patients.name)||"",(e.patients&&e.patients.phone)||"",e.status,itemMethod(e,it),itemCur(e,it),e.card_type||"",it.concepto,it.modificador||"",Number(it.amount),itemCur(e,it)==="USD"?Number(e.fx_rate)||me.fx:"",Math.round(itemMXN(e,it)*100)/100,e.invoice_no||"",(e.notes||"").replace(/\n/g," ")]));});
  const csv=[head,...rows].map(r=>r.map(csvCell).join(",")).join("\n");
  const b=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}),u=URL.createObjectURL(b),a=document.createElement("a");a.href=u;a.download="registro_praxia.csv";a.click();URL.revokeObjectURL(u);toast("CSV exportado");
}

/* ---- BOOT ---- */
(async()=>{
  const qs=new URLSearchParams(location.search),hs=new URLSearchParams(location.hash.replace(/^#/,""));
  if(qs.get("inactivo")){const m=$("#login-msg");m.className="lmsg";m.textContent="Tu sesión se cerró por inactividad. Vuelve a entrar.";history.replaceState(null,"",location.pathname);}
  // Supabase sends failed email links back with error_code (e.g. otp_expired) in the URL.
  const ecode=qs.get("error_code")||hs.get("error_code");
  if(ecode){
    const m=$("#login-msg");m.className="lmsg err";
    m.textContent=ecode==="otp_expired"?"El enlace venció o ya se usó. Si era de confirmación, pide uno nuevo abajo; si era de contraseña, solicita otro.":"No se pudo completar: "+((qs.get("error_description")||hs.get("error_description")||ecode).replace(/\+/g," "));
    history.replaceState(null,"",location.pathname);
    if(ecode==="otp_expired"){const a=document.createElement("a");a.textContent="Reenviar correo de confirmación";a.style.cursor="pointer";a.onclick=()=>showConfirm("","");m.appendChild(document.createElement("br"));m.appendChild(a);}
  }
  const {data:{session}}=await sb.auth.getSession();
  if(session&&recovering){showLoginView("newpass");return;}
  if(session)await initApp();
})();

# Praxia — Plan legal, de privacidad y de seguridad para operar en México

_Fecha: 17 de octubre de 2026 · Rama `legal-compliance-mx` · Base: `main` en `39b3c14` (incluye `0004_security_fixes.sql`)._

> **Qué es esto.** Las 15 cosas que Praxia debe tener para operar en México con datos de pacientes, con su base legal, lo que ya quedó hecho en el código y lo que falta hacer fuera del código. El marco principal es la **Ley Federal de Protección de Datos Personales en Posesión de los Particulares (LFPDPPP)** publicada en el DOF el 20 de marzo de 2025 (vigente desde el 21), que sustituyó a la de 2010 y pasó la autoridad del INAI a la **Secretaría Anticorrupción y Buen Gobierno**. Su Reglamento de 2011 sigue aplicando en lo que no se le oponga.
>
> **Esto no es asesoría legal.** Los textos legales de esta rama son borradores sólidos para que un abogado en México los revise; no los publiques como definitivos sin esa revisión (punto 15).

## Estado en una tabla

| # | Consideración | Base | En esta rama | Falta (quién) |
|---|---|---|---|---|
| 1 | Aviso de privacidad para usuarios (integral + simplificado) | LFPDPPP arts. 15–16 | ✅ `privacidad.html` | Llenar `legal-config.js`; revisión legal |
| 2 | Consentimiento registrado al registrarse y al cambiar la versión | arts. 8–9 | ✅ casilla + modal + `accept_terms()` | Ejecutar `0005` en Supabase |
| 3 | Términos del servicio con cláusulas de encargado | art. 36 y Reglamento | ✅ `terminos.html` | Revisión legal |
| 4 | Aviso + consentimiento expreso para pacientes (datos de salud = sensibles) | art. 9 | ✅ `aviso-pacientes.html` (imprimible, prellenado) | Cada consultorio lo adopta y firma |
| 5 | Derechos ARCO: contacto y autoservicio | arts. 21–31 | ✅ Ajustes → Privacidad (descargar, eliminar) | Correo ARCO real; proceso de 20 días |
| 6 | Cancelación de pacientes compatible con retención fiscal | LFPDPPP + CFF art. 30 | ✅ `anonymize_patient()` + botón en Pacientes | — |
| 7 | Eliminación total del consultorio | obligaciones del encargado | ✅ `delete_clinic()` | — |
| 8 | Cookies/rastreo: solo lo estrictamente necesario, sin terceros | Reglamento art. 14 | ✅ fuentes autoalojadas; divulgación en aviso | — |
| 9 | Cabeceras de seguridad HTTP | art. 19 (deber de seguridad) | ✅ `netlify.toml` (CSP, HSTS…) | Verificar en el sitio desplegado |
| 10 | Autenticación: contraseñas ≥10, restablecer contraseña, cierre por inactividad | art. 19 | ✅ UI | Ajustes en Supabase (abajo) |
| 11 | Bitácora de eventos de privacidad | Reglamento art. 61 | ✅ `privacy_log` + vista para gerentes | — |
| 12 | Plan de respuesta a vulneraciones + security.txt | art. 20 | ✅ `docs/RESPUESTA-A-INCIDENTES.md`, `.well-known/security.txt` | Llenar contactos; 2FA |
| 13 | Retención, respaldos, ubicación de datos, contratos con proveedores | CFF art. 30; LFPDPPP | ✅ documentado en aviso/términos | Supabase Pro; DPAs; confirmar región |
| 14 | Minimización y deslinde de expediente clínico | NOM-004-SSA3-2012 | ✅ textos en UI y términos | Capacitar a recepción |
| 15 | Gobierno: responsable designado, revisión legal, revisión anual | art. 30 | ✅ este plan | Designar; agendar |

---

## Detalle de los 15 puntos

### 1. Aviso de privacidad para usuarios de Praxia
- **Por qué.** Praxia es *responsable* de los datos de quienes usan la app (médicos, gerentes, recepción): nombre, correo, actividad. El art. 15 exige un aviso con identidad y domicilio del responsable, datos tratados, finalidades (distinguiendo las que requieren consentimiento), mecanismos ARCO, y cómo se comunican cambios. El art. 16 permite un aviso simplificado cuando los datos se recaban por medios electrónicos, señalando dónde está el integral.
- **Hecho.** `privacidad.html` (integral, con el simplificado en un recuadro al inicio). Se enlaza desde la pantalla de acceso, el registro y Ajustes → Privacidad. Los datos del responsable se leen de `legal-config.js`.
- **Falta.** Llenar **razón social, domicilio y correos** en `legal-config.js` (hoy hay marcadores entre corchetes; la página los muestra en rojo mientras estén vacíos). Revisión por abogado.

### 2. Consentimiento registrado
- **Por qué.** El consentimiento debe poder probarse. Para cambios relevantes del aviso hay que informar y, cuando aplique, volver a obtenerlo.
- **Hecho.** Casilla obligatoria en «Crear consultorio» y «Unirse con código». La versión y la fecha se guardan en los metadatos del usuario al registrarse y, en el primer inicio de sesión, `accept_terms()` las fija en `profiles.terms_version / terms_accepted_at` y en `privacy_log`. Si cambia `version` en `legal-config.js`, la app muestra un modal que bloquea el uso hasta aceptar (o cerrar sesión).
- **Falta.** Ejecutar `0005_privacy_compliance.sql`. Sin ella la app funciona pero no registra el consentimiento (lo avisa en consola).

### 3. Términos del servicio con condiciones de encargado
- **Por qué.** Respecto de los datos de pacientes, Praxia es *encargado* del consultorio. La ley y el Reglamento exigen que la relación conste por escrito y que el encargado trate datos solo por instrucciones, guarde confidencialidad, aplique seguridad, no transfiera sin instrucción, informe vulneraciones, apoye en ARCO y suprima al terminar.
- **Hecho.** `terminos.html`, sección 6, con esas ocho obligaciones; lista de subencargados (Supabase, Netlify, jsDelivr); deslinde de expediente clínico y de contabilidad; ley y jurisdicción (Tijuana).
- **Falta.** Revisión legal, en particular la limitación de responsabilidad (12) y si el piloto gratuito cambia a precio.

### 4. Aviso y consentimiento expreso para pacientes
- **Por qué.** El nombre del servicio pagado (FACO, LASER YAG…) revela información de **salud**: dato sensible. El art. 9 exige **consentimiento expreso y por escrito** del titular para datos sensibles. El responsable es el consultorio; Praxia debe facilitarle cumplir.
- **Hecho.** `aviso-pacientes.html`: plantilla imprimible con el nombre del consultorio y del médico ya puestos (Ajustes → Privacidad → «Abrir»), campos editables para domicilio y contacto, cláusula de consentimiento expreso y línea de firma, más el texto corto para el letrero de recepción. Versión editable en `docs/plantillas/aviso-privacidad-pacientes.md`.
- **Falta.** Que cada consultorio lo adapte, lo imprima y conserve las firmas. Conviene incluirlo en el alta de cada clínica.

### 5. Derechos ARCO
- **Por qué.** Arts. 21–31: acceso, rectificación, cancelación y oposición; respuesta en 20 días hábiles y ejecución en 15 (plazos de la ley anterior que la nueva mantiene en lo sustancial; **verificar los artículos exactos en el texto del DOF**).
- **Hecho.** Ajustes → Privacidad: descargar mis datos (`export_my_data()`), eliminar mi cuenta (`delete_my_account()`), enlaces a los documentos y correo de contacto. El nombre se rectifica desde el perfil. Para pacientes, el consultorio usa edición, exportación CSV y anonimización.
- **Falta.** Correo `correoPrivacidad` real y atendido; un responsable que lleve el registro de solicitudes y plazos.

### 6. Cancelación de datos de pacientes sin perder la contabilidad
- **Por qué.** La cancelación puede negarse en lo necesario para cumplir obligaciones legales; el CFF art. 30 exige conservar la contabilidad **5 años**. La solución estándar es anonimizar.
- **Hecho.** `anonymize_patient()`: borra nombre, teléfono, correo, notas del paciente y las notas de sus visitas (también en `entry_audit`); conserva fechas, conceptos e importes. Requiere permiso `deleteEntries` o ser gerente. Botón «Anonimizar» en la ficha del paciente. Probado en Postgres local.

### 7. Eliminación total del consultorio
- **Por qué.** Al terminar la relación, el encargado debe suprimir o devolver los datos. También es portabilidad práctica: exportar CSV + borrar.
- **Hecho.** `delete_clinic(nombre)`: el gerente teclea el nombre exacto; se borran pacientes, entradas, cobros, categorías, invitaciones, historial y configuración; el personal conserva su cuenta pero sale del consultorio; queda un evento en `privacy_log`. Probado.
- **Nota.** Los archivos adjuntos (`entry-files` en Storage) no se usan aún; si se implementan, hay que borrar también los objetos del bucket vía la API de Storage.

### 8. Cookies y tecnologías de rastreo
- **Por qué.** El Reglamento (art. 14) exige informar el uso de cookies/web beacons y cómo deshabilitarlas. No hay obligación de banner si solo se usa almacenamiento estrictamente necesario, pero sí de informar.
- **Hecho.** La app no usa cookies ni analítica. Guarda el token de sesión en `localStorage`; esto se explica en el aviso (sección 7). Las **fuentes se autoalojan** en `fonts/` (antes Google Fonts recibía la IP de cada visitante). Queda jsDelivr para `supabase-js`, declarado como encargado.
- **Opcional.** Copiar `supabase.js` al repositorio eliminaría al último tercero y permitiría una CSP sin `cdn.jsdelivr.net`.

### 9. Cabeceras de seguridad HTTP
- **Hecho.** `netlify.toml`: `Content-Security-Policy` (scripts solo del sitio y jsDelivr con SRI; conexiones solo a nuestro Supabase; sin iframes de terceros; sin plugins), `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`. La app se probó en Chromium con esta CSP sin violaciones.
- **Falta.** Tras el deploy, comprobar con `curl -I https://<sitio>` que las cabeceras llegan. `script-src` lleva `'unsafe-inline'` porque el código vive dentro de `index.html`; moverlo a `app.js` permitiría quitarlo.

### 10. Autenticación y sesiones
- **Hecho.** Contraseña mínima de 10 caracteres en la UI; flujo «¿Olvidaste tu contraseña?» (`resetPasswordForEmail` → pantalla de nueva contraseña); cierre de sesión automático a los 30 minutos sin actividad con aviso a los 29 (equipos compartidos en recepción).
- **Falta (Supabase → Authentication):**
  - Providers → Email → **Confirm email: ON** (ya lo exige el README), **Minimum password length: 10**.
  - Password security → activar **Leaked password protection** (si el plan lo permite).
  - URL Configuration → Site URL = URL de producción; añadir `https://deploy-preview-*--<sitio>.netlify.app/**` a Redirect URLs para que el enlace de restablecimiento funcione en previews.
  - SMTP propio (Settings → Auth → SMTP): el correo integrado de Supabase es para pruebas y tiene límites por hora; sin SMTP, confirmación y restablecimiento fallarán con varios usuarios.
  - Opcional: MFA para gerentes.

### 11. Bitácora de eventos de privacidad
- **Por qué.** El Reglamento (art. 61) pide bitácoras como medida de seguridad y permiten demostrar cumplimiento (quién aceptó qué, quién anonimizó, quién borró).
- **Hecho.** Tabla `privacy_log` (solo escribible por las funciones del servidor), visible para el gerente de su consultorio y para cada persona sobre sus propios eventos. Se suma a `entry_audit` (0004), que ya registra cambios en entradas y cobros.

### 12. Plan de respuesta a vulneraciones
- **Por qué.** Art. 20: informar **de forma inmediata** a los titulares las vulneraciones que afecten significativamente sus derechos. Como encargado, Praxia informa al consultorio para que éste informe a sus pacientes.
- **Hecho.** `docs/RESPUESTA-A-INCIDENTES.md` (contener → evaluar → notificar → cerrar, con plantilla de aviso), `/.well-known/security.txt` y `SECURITY.md`.
- **Falta.** Nombrar responsable y suplente; llenar la tabla de accesos; activar **2FA** en GitHub, Netlify y Supabase.

### 13. Retención, respaldos, ubicación y contratos
- **Hecho.** Plazos declarados en el aviso: cuenta mientras exista; registros contables 5 años (del consultorio); logs técnicos ≤12 meses; respaldos del proveedor ≤30 días. Transferencia internacional (EE. UU.) declarada en aviso, términos y plantilla de pacientes.
- **Falta (socios):**
  - **Supabase Pro** (USD 25/mes): respaldos diarios con 7 días de retención y sin pausa por inactividad. En Free **no hay respaldos**; mientras tanto, `supabase db dump` semanal guardado fuera de Supabase.
  - Confirmar la **región** del proyecto `yqsgeywhilqrsombekce` (Project Settings → General) y corregir «Estados Unidos (AWS)» en `legal-config.js` si no coincide.
  - Aceptar/firmar los **DPA** de Supabase y Netlify (ambos los ofrecen en línea) y guardarlos con los documentos de la empresa.
  - Si el repositorio sigue siendo público, no es una fuga (la clave publicable es pública por diseño), pero decidirlo de forma consciente.

### 14. Minimización y deslinde de expediente clínico
- **Por qué.** Praxia es un registro financiero. La NOM-004-SSA3-2012 (expediente clínico) y la NOM-024-SSA3-2012 (registros electrónicos de salud) imponen requisitos que Praxia no cumple ni pretende cumplir. Mientras menos datos clínicos entren, menor el riesgo y la carga legal.
- **Hecho.** El campo de notas dice «no registres diagnósticos ni datos clínicos»; los términos (2 y 4) obligan al consultorio a no capturarlos; la plantilla de pacientes lo aclara. Los campos de paciente siguen siendo solo nombre y teléfono opcional.
- **Falta.** Decirlo en la capacitación de recepción. Considerar un aviso al guardar si las notas contienen palabras clínicas frecuentes.

### 15. Gobierno
- **Falta (socios):**
  - Designar a la persona **responsable de protección de datos** (la ley exige designar a quien atienda solicitudes) y su suplente; publicar su correo en `legal-config.js`.
  - **Revisión por abogado** de `privacidad.html`, `terminos.html` y la plantilla, verificando contra el texto del DOF (en especial plazos ARCO, art. 9 sobre datos sensibles y art. 20 sobre vulneraciones). Fijar la fecha en `version` cuando se publiquen.
  - Compartir la propiedad de GitHub/Netlify/Supabase entre al menos dos socios (ver `CODE_REVIEW.md` §2).
  - Agendar una **revisión anual** de este plan y de los subencargados.

---

## Cómo poner esto en producción (orden)

1. **Mergear a `main`.** Netlify despliega. La app funciona aunque todavía no se haya ejecutado `0005`.
2. **Ejecutar `0005_privacy_compliance.sql`** en Supabase → SQL Editor (después de `0004`). Verificar:
   ```sql
   select proname from pg_proc where proname in ('accept_terms','anonymize_patient','delete_clinic','delete_my_account','export_my_data') order by 1;  -- 5 filas
   select count(*) from information_schema.columns where table_name='profiles' and column_name in ('terms_version','terms_accepted_at');            -- 2
   ```
   Si `delete_my_account()` fallara en producción con *permission denied for table users*, ejecutar en el SQL Editor: `grant delete on auth.users to postgres;` y reintentar.
3. **Llenar `legal-config.js`** (responsable, domicilio, correos, sitio) y `.well-known/security.txt`. Hasta entonces las páginas muestran los campos pendientes en rojo.
4. **Ajustes de Supabase Auth** del punto 10.
5. **Comprobar cabeceras**: `curl -I https://<sitio>/ | grep -i -E "content-security|strict-transport|x-frame"`.
6. **Supabase Pro** o respaldo manual (punto 13).
7. **Revisión legal** y, al publicar la versión final, actualizar `version` en `legal-config.js` para que todos vuelvan a aceptar.

## Qué se verificó

- `0005` aplicada sobre `0001–0004` en PostgreSQL 16 local con un sustituto del esquema `auth` de Supabase; escenarios con gerente, recepción, otra clínica y anónimo: consentimiento visible según rol; anonimización bloqueada sin permiso y entre clínicas, borra notas (incluidas copias en `entry_audit`) y conserva importes; eliminación de consultorio exige rol y nombre exacto y no toca la otra clínica; eliminación de cuenta bloquea al único gerente con datos y borra perfil + usuario; funciones internas no ejecutables por los roles de la API.
- `index.html` en Chromium con la CSP real y la librería `supabase-js` exacta (hash SRI verificado) contra un API simulado: modal de consentimiento bloquea y acepta con la versión correcta; aceptación silenciosa cuando se marcó la casilla al registrarse; app funcional **sin** `0005` con mensajes claros; pestaña Privacidad, descarga JSON, anonimizar desde Pacientes, cierre por inactividad a los 30 min con aviso, validaciones de registro, solicitud y flujo de restablecimiento de contraseña; cero violaciones de CSP y cero peticiones a Google Fonts. Las tres páginas legales renderizan y rellenan los datos de `legal-config.js`.
- **No verificado:** nada en la Supabase ni el Netlify reales (sin acceso desde esta sesión).

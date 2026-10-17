# Praxia — Procedimiento de respuesta a incidentes de seguridad

_Base legal: LFPDPPP (2025) art. 20 — las vulneraciones de seguridad que afecten de forma significativa los derechos patrimoniales o morales de los titulares deben informarse **de forma inmediata** al titular. Praxia, como encargado, informa al consultorio (responsable) para que éste informe a sus pacientes; para los datos de las propias personas usuarias, Praxia es el responsable e informa directamente._

## 0. Antes de que pase nada (preparación)

- [ ] Responsable de seguridad designado: **[nombre]**, suplente: **[nombre]**. Correo de contacto: el de `correoSeguridad` en `legal-config.js` (también en `/.well-known/security.txt`).
- [ ] Acceso de **al menos dos socios** a Supabase, Netlify y GitHub (ver `docs/PLAN-LEGAL-MX.md`, punto 15).
- [ ] 2FA activado en los tres servicios.
- [ ] Supabase Pro (respaldos diarios) o respaldo manual semanal con `supabase db dump`.
- [ ] Lista de contactos de los consultorios activos (gerente + correo) fuera de Praxia, para poder avisarles aunque la app esté caída.
- [ ] Este documento impreso o guardado fuera del repositorio.

## 1. Qué cuenta como incidente

- Acceso no autorizado a la base de datos o a una cuenta (contraseña robada, sesión abierta en equipo compartido usada por un tercero).
- Pérdida, destrucción o alteración de datos (borrado accidental masivo, migración fallida).
- Fuga de credenciales: la **clave secreta / service_role** de Supabase, la contraseña de la base de datos, tokens de Netlify o GitHub expuestos (en un commit, un chat, una captura).
- Vulnerabilidad reportada por un tercero (vía security.txt o correo).
- Dispositivo de un socio o de un consultorio robado/perdido con sesión abierta.
- Incidente en un proveedor (Supabase, Netlify) que afecte nuestros datos.

## 2. Primeras 2 horas: contener

1. **Anota la hora** y quién detectó el incidente. Abre un registro (documento compartido) donde se apunte todo lo que se hace, con hora.
2. **Corta el acceso:**
   - Cuenta comprometida → en Supabase: Authentication → Users → el usuario → *Sign out everywhere* / restablecer contraseña; si es gerente, revisa también `Ajustes → Personal` por invitaciones generadas.
   - Clave secreta expuesta → Supabase → Project Settings → API → **rotar** la clave secreta y el JWT secret si aplica; revisa en los logs qué se hizo con ella.
   - Credenciales de Netlify/GitHub → revocar tokens y sesiones, cambiar contraseñas.
   - Si hay duda sobre la integridad de la app desplegada → en Netlify, **rollback** al último deploy conocido como bueno (Deploys → … → *Publish deploy*).
3. **Preserva evidencia:** exporta los logs de Supabase (Logs → Auth / Postgres / API) del periodo afectado y las tablas `entry_audit` y `privacy_log` del consultorio afectado antes de tocar nada más.
4. **No borres datos** para "limpiar": podría destruir la evidencia y agravar la pérdida.

## 3. Primeras 24 horas: evaluar

Responde por escrito en el registro:

- ¿Qué datos se vieron afectados? (de qué consultorios; usuarios y/o pacientes; qué campos: nombres, teléfonos, servicios/pagos, notas).
- ¿Cuántos titulares? ¿Desde cuándo y hasta cuándo?
- ¿Hubo acceso de lectura, modificación o borrado? (usa `entry_audit` y `privacy_log`).
- ¿Es **significativo** para los derechos patrimoniales o morales de los titulares? Dato de salud expuesto a terceros = sí, por regla general. Si hay duda, trátalo como significativo.
- ¿Está contenido? ¿Qué falta por hacer?

## 4. Notificar

| A quién | Cuándo | Cómo | Contenido mínimo |
|---|---|---|---|
| **Consultorios afectados** (responsables de sus pacientes) | De forma inmediata una vez confirmada la vulneración; a más tardar dentro de las 72 h de detectarla | Correo al gerente + llamada | Lo que ocurrió, cuándo, qué datos y de qué pacientes, qué hicimos, qué les recomendamos hacer, y que **ellos** deben informar a sus pacientes afectados (podemos darles la plantilla de abajo) |
| **Usuarios afectados** (médicos/recepción) | De forma inmediata | Correo | Ídem, más: cambiar contraseña, revisar accesos |
| **Autoridad** (Secretaría Anticorrupción y Buen Gobierno) | Cuando la ley o el reglamento vigente lo exijan, o si se considera prudente | Según el canal que la autoridad publique | Según la autoridad |
| **Proveedor** (Supabase/Netlify) | Si el incidente involucra su plataforma | Soporte | Ticket con detalles técnicos |

### Plantilla de aviso al titular (adaptar)

> **Asunto: Aviso de incidente de seguridad — [Praxia / Consultorio X]**
>
> Le informamos que el [fecha] detectamos [descripción breve]. La información que pudo verse afectada es: [datos]. Hasta donde sabemos, [alcance: si hubo acceso/uso].
> Medidas tomadas: [contención, rotación de credenciales, etc.].
> Le recomendamos: [cambiar contraseña / estar atento a comunicaciones sospechosas / etc.].
> Puede contactarnos en [correo/teléfono] para cualquier duda o para ejercer sus derechos ARCO.
> Lamentamos lo ocurrido. [Firma del responsable]

## 5. Cerrar

- [ ] Causa raíz identificada y corregida (código, configuración o proceso).
- [ ] Prueba de que la corrección funciona.
- [ ] Informe final en el registro: cronología, impacto, acciones, lecciones.
- [ ] Actualizar este documento y `docs/PLAN-LEGAL-MX.md` si hace falta.
- [ ] Conservar el expediente del incidente al menos 5 años.

## 6. Contactos y accesos (llenar; no subir credenciales al repositorio)

| Servicio | Quién tiene acceso de administrador | Dónde está el 2FA de respaldo |
|---|---|---|
| Supabase (proyecto `yqsgeywhilqrsombekce`) | | |
| Netlify | | |
| GitHub (`diegocorralr1-boop/Praxia`) | | |
| Dominio / DNS | | |

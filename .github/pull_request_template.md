## Qué cambia y por qué

<!-- Una o dos frases. Enlaza el punto del plan o el issue si aplica. -->

## Base de datos

- [ ] No toca la base de datos
- [ ] Agrega una migración nueva `000N_*.sql` (nunca se edita una ya aplicada) · **Aplicada en producción por:** ___ **el:** ___
- [ ] La app sigue funcionando si la migración aún no se aplicó (mensaje claro, sin romper)

## Pruebas

- [ ] `npm run check` pasa en local (lint, HTML, SQL, navegador)
- [ ] Probado en el deploy preview de Netlify: Entradas, Calendario, Pacientes, Analíticas, Ajustes
- [ ] Nuevas pruebas para lo que cambia (SQL en `tests/sql`, navegador en `tests/e2e`)

## Privacidad y seguridad

- [ ] No expone datos de pacientes a nadie que no los veía antes (RLS revisada si cambió)
- [ ] No añade claves secretas al repositorio
- [ ] Si cambia textos legales: `version` en `legal-config.js` actualizada

## Capturas (si cambia la interfaz)

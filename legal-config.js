// Datos del responsable del tratamiento (Praxia) y versión vigente de los documentos legales.
// ÚNICO lugar que hay que llenar: lo leen index.html, privacidad.html, terminos.html y aviso-pacientes.html.
// Los campos entre corchetes son obligatorios antes de operar con pacientes reales.
window.PRAXIA_LEGAL = {
  // Quién responde por los datos de los USUARIOS de Praxia (médicos y recepción).
  responsable:      "[RAZÓN SOCIAL O NOMBRE COMPLETO DEL RESPONSABLE]",
  domicilio:        "[CALLE Y NÚMERO, COLONIA, C.P., TIJUANA, BAJA CALIFORNIA, MÉXICO]",
  correoPrivacidad: "[privacidad@tudominio.mx]",     // recibe solicitudes ARCO y revocaciones
  correoSeguridad:  "[seguridad@tudominio.mx]",      // recibe reportes de vulnerabilidades e incidentes
  sitio:            "[https://tu-sitio.netlify.app]",

  // Al cambiar la versión, la app vuelve a pedir a cada usuario que acepte el Aviso y los Términos.
  version: "2026-10-17",

  // Terceros que tratan datos por cuenta de Praxia (encargados / subencargados).
  encargados: [
    { nombre: "Supabase, Inc.",  servicio: "Base de datos, autenticación y copias de seguridad", pais: "Estados Unidos (AWS)" },
    { nombre: "Netlify, Inc.",   servicio: "Alojamiento del sitio y red de entrega de contenido",  pais: "Estados Unidos" },
    { nombre: "jsDelivr",        servicio: "Entrega de la librería supabase-js al navegador",       pais: "Red global de CDN" }
  ],

  // Autoridad garante en México tras la LFPDPPP de 2025 (antes INAI).
  autoridad:   "Secretaría Anticorrupción y Buen Gobierno",
  jurisdiccion: "Tijuana, Baja California, México"
};

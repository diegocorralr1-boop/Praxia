// Configuración por entorno. Un solo lugar para las URLs y claves públicas de Supabase.
// Producción es el valor por defecto. Cuando exista un segundo proyecto de Supabase para
// desarrollo, llena ENVS.development: localhost y los deploy previews de Netlify lo usarán
// automáticamente y dejarán de tocar los datos reales.
(function () {
  var ENVS = {
    production: {
      supabaseUrl: "https://yqsgeywhilqrsombekce.supabase.co",
      supabaseKey: "sb_publishable_U5Li7wfZ_ttx9wYlEnqSKQ_CjvQKbVB",
    },
    development: {
      supabaseUrl: "", // [por llenar] p. ej. https://xxxx.supabase.co
      supabaseKey: "", // [por llenar] clave publishable del proyecto de desarrollo
    },
  };
  var host = location.hostname;
  var isPreview = /^(localhost|127\.0\.0\.1)$/.test(host) || /^deploy-preview-\d+--/.test(host);
  var env = isPreview && ENVS.development.supabaseUrl ? "development" : "production";
  if (isPreview && env === "production") {
    console.info("Praxia: sin proyecto de desarrollo configurado en config.js; este preview usa la base de producción.");
  }
  window.PRAXIA_CONFIG = {
    env: env,
    isPreview: isPreview,
    current: ENVS[env],
    version: "2026.10.19", // súbela en cada release (también aparece en Ajustes → General y en los reportes de error)
  };
})();

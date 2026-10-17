// Rellena los documentos legales con los datos de legal-config.js (siempre como texto, nunca como HTML).
(function(){
  var L=window.PRAXIA_LEGAL||{};
  document.querySelectorAll("[data-legal]").forEach(function(el){
    var v=L[el.getAttribute("data-legal")];
    if(v==null||v==="")return;
    if(/^https?:\/\//.test(String(v))&&el.tagName!=="A"){var a=document.createElement("a");a.href=v;a.textContent=v;a.rel="noopener";el.textContent="";el.appendChild(a);}
    else if(/^[^\s@\[]+@[^\s@]+\.[^\s@]+$/.test(String(v))){var m=document.createElement("a");m.href="mailto:"+v;m.textContent=v;el.textContent="";el.appendChild(m);}
    else el.textContent=v;
  });
  var tb=document.querySelector("#tabla-encargados tbody");
  if(tb&&Array.isArray(L.encargados)){
    L.encargados.forEach(function(e){
      var tr=document.createElement("tr");
      [e.nombre,e.servicio,e.pais].forEach(function(t){var td=document.createElement("td");td.textContent=t||"";tr.appendChild(td);});
      tb.appendChild(tr);
    });
  }
})();

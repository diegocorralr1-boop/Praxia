// Pre-fill clinic/doctor from the query string (set by the app), always as text.
(function(){
  var q=new URLSearchParams(location.search);
  var c=(q.get("consultorio")||"").trim().slice(0,120), r=(q.get("responsable")||"").trim().slice(0,120);
  if(c)document.getElementById("f-consultorio").textContent=c;
  if(r)document.getElementById("f-responsable").textContent=r;
  function sync(){var v=document.getElementById("f-consultorio").textContent.trim();document.getElementById("s-consultorio").textContent=v||"[Nombre del consultorio]";}
  document.getElementById("f-consultorio").addEventListener("input",sync);sync();
  document.getElementById("print").onclick=function(){window.print();};
  document.getElementById("clear").onclick=function(){document.querySelectorAll(".fill").forEach(function(e){e.textContent="";});sync();};
})();

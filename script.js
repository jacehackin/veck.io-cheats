   const c = JSON.parse(localStorage.veck_v9);
   c.fps = 15; c.readCap = 700; c.capMode = 'raf';
   localStorage.veck_v9 = JSON.stringify(c);
   location.reload();
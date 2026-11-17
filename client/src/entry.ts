// The page's one entry point: the game, or (with ?soundtest=1) the sound test page, which needs no server or map.
if (new URLSearchParams(location.search).has('soundtest')) void import('./soundtest');
else void import('./main');

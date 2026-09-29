# Sitio público de MyHaus

Los archivos de `www.myhaus.cl`. Es HTML y CSS plano: **no hay que compilar
nada**, se suben tal cual y funciona.

```
landing/
├── index.html     la página completa
├── estilos.css    todos los estilos
└── img/           capturas reales de la app e iconos
```

## Antes de subir: revisa una línea

Al final de `index.html` está la dirección de la app, en un solo lugar:

```js
var DIRECCION_APP = 'https://app.myhaus.cl';
```

Mientras el subdominio `app.myhaus.cl` no esté configurado, cámbiala por la
dirección actual de Render y todos los botones apuntarán ahí.

## Cómo se ve antes de publicar

```bash
cd landing
python3 -m http.server 8080
```

Y abres `http://localhost:8080`.

## Dónde publicarlo

Los pasos completos —dónde subirlo, cómo queda el DNS y qué variables hay que
tocar en la app— están en **[HOSTING.md](../HOSTING.md)**, en la raíz del
repositorio. En resumen: **Cloudflare Pages**, gratis, arrastrando esta carpeta.

Alternativas equivalentes, por si acaso:

- **Netlify**: arrastras la carpeta en [app.netlify.com/drop](https://app.netlify.com/drop).
- **GitHub Pages**: gratis, sirviendo desde este mismo repositorio.
- **El mismo servidor de la app**: `hosting/docker-compose.yml` ya sirve esta
  carpeta con Caddy, así que en un VPS el sitio no cuesta un servicio aparte.

## Qué falta, cuando haya tiempo

- Términos de uso y política de privacidad, con sus enlaces en el pie.
- Una imagen propia para compartir por WhatsApp (`og:image`); hoy usa el icono.
- Textos revisados por ustedes: los de ahora describen la app tal como está,
  pero las palabras son mías.

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

Es un sitio estático, así que hay opciones gratis y buenas. Recomendación:
**Cloudflare Pages**.

### Cloudflare Pages (gratis, recomendado)

1. Crea una cuenta en [dash.cloudflare.com](https://dash.cloudflare.com).
2. **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
3. Arrastra la carpeta `landing` completa.
4. En **Custom domains**, agrega `www.myhaus.cl` y `myhaus.cl`.

Cloudflare te pide apuntar los nameservers del dominio hacia ellos: eso se hace
una vez en el panel de nic.cl, y de paso te deja administrar todo el DNS —
incluido el subdominio de la app— desde un solo lugar.

El certificado HTTPS lo emite y renueva Cloudflare solo.

### Alternativas equivalentes

- **Netlify**: arrastras la carpeta en [app.netlify.com/drop](https://app.netlify.com/drop).
- **GitHub Pages**: gratis, sirviendo desde este mismo repositorio.
- **El mismo servidor de la app**: si más adelante todo queda en un VPS, el
  sitio puede vivir junto a la app y ahorrarse un servicio.

## Cómo quedan las direcciones

| Dirección | Qué hay |
|---|---|
| `www.myhaus.cl` | este sitio |
| `myhaus.cl` | redirige a `www` |
| `app.myhaus.cl` | la aplicación |

Mantener el sitio y la app en direcciones distintas es lo que hacen Fintoc,
Kuanto y compañía, y hay una razón práctica: la app se instala en el teléfono y
su alcance es todo el dominio donde vive. Con el sitio en la misma dirección, la
página de marketing quedaría dentro de la app instalada.

## Al configurar el subdominio de la app

Cuando `app.myhaus.cl` apunte al servidor, hay que decirle a la app cuál es su
dirección. En el panel del proveedor, dos variables:

```
WEB_ORIGIN=https://app.myhaus.cl
CANONICAL_HOST=app.myhaus.cl
```

Y si ya conectaste Gmail, agregar en Google Cloud la URI
`https://app.myhaus.cl/api/gmail/callback`.

## Qué falta, cuando haya tiempo

- Términos de uso y política de privacidad, con sus enlaces en el pie.
- Una imagen propia para compartir por WhatsApp (`og:image`); hoy usa el icono.
- Textos revisados por ustedes: los de ahora describen la app tal como está,
  pero las palabras son mías.

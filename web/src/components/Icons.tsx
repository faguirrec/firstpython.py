import type { SVGProps } from 'react';

/**
 * Iconos y marca, en SVG dentro del bundle: sin fuentes de iconos ni peticiones
 * externas, y heredan el color del texto para funcionar en claro y oscuro.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 24, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconoResumen = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
    <path d="M10 21v-5.5M14 21v-8" />
  </Icon>
);

export const IconoMovimientos = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6h16M4 12h16M4 18h10" />
  </Icon>
);

export const IconoReparto = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 8h13l-3-3M20 16H7l3 3" />
  </Icon>
);

export const IconoAnalisis = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Icon>
);

export const IconoAjustes = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
  </Icon>
);

export const IconoMas = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconoAlerta = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 2.5 20h19L12 3.5Z" />
    <path d="M12 10v4M12 17.2v.1" />
  </Icon>
);

export const IconoCorreo = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </Icon>
);

export const IconoMeta = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="4.5" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
  </Icon>
);

export const IconoBolsillo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7h18v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    <path d="M3 7V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v1M16 13h3" />
  </Icon>
);

export const IconoVer = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const IconoOculto = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.9 5.7A11 11 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a19 19 0 0 1-3.3 4.2" />
    <path d="M6.4 6.9A18.6 18.6 0 0 0 2 12s3.6 6.5 10 6.5c1.6 0 3-.4 4.2-1" />
    <path d="M10 10a2.8 2.8 0 0 0 4 4" />
    <path d="m3.5 3.5 17 17" />
  </Icon>
);

export const IconoBuscar = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m16.5 16.5 4 4" />
  </Icon>
);

/**
 * La marca: una casa cuyo interior son dos columnas de distinta altura.
 * Es literalmente lo que hace la app — un hogar, dos aportes proporcionales—
 * y se sigue leyendo a 16 píxeles.
 */
export function Logo({ size = 40, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      role="img"
      aria-label="Cuentas del Hogar"
      {...rest}
    >
      <rect width="48" height="48" rx="11" fill="var(--marca, #2a78d6)" />
      {/* Techo */}
      <path
        d="M9.5 22.5 24 10.5l14.5 12"
        stroke="#fff"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Las dos columnas: lo que las distingue es la altura, no el color. Con
          una más tenue se leía como una sola barra al achicar el icono. */}
      <rect x="16" y="27" width="6" height="11" rx="1.6" fill="#fff" />
      <rect x="26" y="22.5" width="6" height="15.5" rx="1.6" fill="#fff" />
      {/* Suelo */}
      <path d="M12 38.8h24" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

/** Marca con el nombre, para las cabeceras. */
export function Marca({ size = 34 }: { size?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <Logo size={size} />
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
        <strong style={{ fontSize: '1.02rem', letterSpacing: '-0.01em' }}>Cuentas del Hogar</strong>
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>según lo que gana cada uno</span>
      </span>
    </span>
  );
}

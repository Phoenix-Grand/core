// Logo Kubuno - marque officielle (hexagone + cube 3D), image fournie par
// l'utilisateur. Servi depuis `/kubuno-logo.png` (le host sert `public/`), donc
// disponible partout où `@ui` est consommé (instance unique côté host).
// Le logo est multicolore : une classe de couleur (`text-*`) n'a plus d'effet ;
// on le sert dans ses couleurs de marque. La largeur suit le ratio 512:567.
interface KubunoLogoProps {
  /** Hauteur du logo en px (la largeur suit le ratio 512:567). */
  size?:      number
  className?: string
  title?:     string
}

export function KubunoLogo({ size = 24, className, title = 'Kubuno' }: KubunoLogoProps) {
  return (
    <img
      src="/kubuno-logo.png"
      width={Math.round((size * 512) / 567)}
      height={size}
      alt={title}
      className={className}
      draggable={false}
    />
  )
}

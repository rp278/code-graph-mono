export function BrandMark({ size = 34 }) {
  return (
    <img
      className="brand-mark"
      src="/logo.svg"
      width={size}
      height={size}
      style={{ width: size, height: size }}
      alt=""
      aria-hidden="true"
    />
  );
}

export default function Brand({ size = 'md', onClick, subtitle = true }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`brand ${onClick ? 'brand-btn' : ''} brand-${size}`}
      onClick={onClick}
      type={onClick ? 'button' : undefined}
    >
      <BrandMark size={size === 'lg' ? 72 : 36} />
      <div className="brand-text">
        <h1>CodeGraph</h1>
        {subtitle && <span className="brand-sub">knowledge graph for your codebase</span>}
      </div>
    </Tag>
  );
}

import React from "react";

export interface LinkCardProps {
  href: string;
  title: string;
  description?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}

export const LinkCard: React.FC<LinkCardProps> = ({
  href,
  title,
  description,
  style,
  className = "",
}) => {
  return (
    <a
      href={href}
      className={`rp-block rp-border-b rp-border-solid rp-border-divider-light rp-bg-bg rp-py-4 rp-px-0 rp-transition-colors hover:rp-bg-bg-soft rp-no-underline ${className}`}
      style={style}
    >
      <div className="rp-text-lg rp-font-semibold rp-mb-2 rp-text-text-1 rp-leading-7">
        {title}
      </div>
      {description && (
        <div className="rp-text-text-2 rp-text-sm rp-leading-6">
          {description}
        </div>
      )}
    </a>
  );
};


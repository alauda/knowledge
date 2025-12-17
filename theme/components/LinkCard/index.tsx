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
    <a href={href} className={`link-card ${className}`} style={style}>
      <div className="link-card__title">{title}</div>
      {description && <div className="link-card__description">{description}</div>}
    </a>
  );
};


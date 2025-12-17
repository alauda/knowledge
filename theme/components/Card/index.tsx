import React from "react";

export interface CardProps {
  title?: string;
  content?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({
  title,
  content,
  style,
  className = "",
  children,
}) => {
  return (
    <div className={`card ${className}`} style={style}>
      {title && <div className="card__title">{title}</div>}
      {content && <div className="card__content">{content}</div>}
      {children && <div className="card__content">{children}</div>}
    </div>
  );
};


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
    <div
      className={`rp-border rp-block rp-border-solid rp-border-divider-light rp-rounded-lg rp-bg-bg rp-p-4 ${className}`}
      style={style}
    >
      {title && (
        <div className="rp-text-lg rp-font-semibold rp-mb-3 rp-text-text-1">
          {title}
        </div>
      )}
      {content && <div className="rp-text-text-2">{content}</div>}
      {children && <div className="rp-text-text-2">{children}</div>}
    </div>
  );
};


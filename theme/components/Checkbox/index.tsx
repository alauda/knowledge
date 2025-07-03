import { forwardRef, useCallback } from "react";
import { useI18n } from "rspress/runtime";

export interface CheckboxProps {
  label: string;
  disabled?: boolean;
  className?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (e: string) => void;
}

export default forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      label,
      disabled = false,
      className = "",
      checked,
      defaultChecked = false,
      onChange,
      ...props
    },
    ref
  ) => {
    const handleChange = useCallback(() => {
      onChange?.(label);
    }, [onChange]);

    return (
      <label
        className={`flex items-center space-x-2 cursor-pointer ${
          disabled ? "opacity-50 cursor-not-allowed" : ""
        } ${className}`}
      >
        <input
          type="checkbox"
          ref={ref}
          checked={checked}
          onChange={handleChange}
          disabled={disabled}
          className={`
            w-4 h-4 
            rounded 
            border border-gray-300 
            bg-white 
            text-blue-600 
            shadow-sm 
            focus:ring-blue-500 
            focus:ring-2 
            focus:ring-offset-2 
            transition-all 
            duration-200
            !mr-2
            ${disabled ? "bg-gray-100" : "hover:border-gray-400"}
            ${checked ? "border-blue-600 bg-blue-600" : ""}
          `}
          {...props}
        />
        {label && (
          <span
            className={`
              text-l font-medium 
              ${disabled ? "text-gray-500" : "text-black-700"}
              transition-colors duration-200
            `}
          >
            {label}
          </span>
        )}
      </label>
    );
  }
);

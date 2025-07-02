import React from "react";

interface SearchProps {
  value: string;
  onSearch: (query: string) => void;
  placeholder?: string;
  className?: string;
}

const Search: React.FC<SearchProps> = ({
  value,
  onSearch,
  placeholder = "Search by ID or Content",
  className = "",
}) => {
  return (
    <div className={`relative max-w-full ${className}`}>
      <div className="flex items-center bg-[var(--rp-c-bg-mute)] rounded-[var(--rp-radius)] border border-gray-300  px-4 py-2 shadow-sm transition-all duration-200 focus-within:border-blue-500 focus-within:ring-1 focus-within:ring-blue-500 hover:shadow-md">
        <svg
          className="h-5 w-5 flex-shrink-0 text-gray-400 dark:text-gray-400 mr-2"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>

        <input
          type="text"
          value={value}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={placeholder}
          className="ml-3 w-full border-0 bg-transparent p-0 text-gray-900 placeholder-gray-400 outline-none focus:ring-0 dark:text-gray-100 dark:placeholder-gray-500"
        />
      </div>
    </div>
  );
};

export default Search;

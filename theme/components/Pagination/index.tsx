import { useI18n } from "@rspress/core/runtime";
import classnames from "classnames";
import { useMemo } from "react";

interface PaginationProps {
  currentPage: number;
  totalPage: number;
  onChange: (page: number) => void;
}

interface PageItem {
  page: string | number;
  disabled: boolean;
}

const Pagination = ({ currentPage, totalPage, onChange }: PaginationProps) => {
  const neighBorsNumber = 1;
  const t = useI18n();

  const paginationItems = useMemo(() => {
    const items: Array<PageItem> = [];

    items.push({
      page: 1,
      disabled: false,
    });

    if (currentPage - neighBorsNumber > 2) {
      items.push({
        page: "...",
        disabled: true,
      });
      for (let i = currentPage - neighBorsNumber; i < currentPage; i++) {
        items.push({
          page: i,
          disabled: false,
        });
      }
    } else {
      for (let i = 2; i < currentPage; i++) {
        items.push({
          page: i,
          disabled: false,
        });
      }
    }

    for (
      let i = Math.max(2, currentPage);
      i < Math.min(currentPage + neighBorsNumber + 1, totalPage);
      i++
    ) {
      items.push({
        page: i,
        disabled: false,
      });
    }
    if (currentPage + neighBorsNumber < totalPage - 1) {
      items.push({
        page: "...",
        disabled: true,
      });
    }
    if (totalPage > 1) {
      items.push({
        page: totalPage,
        disabled: false,
      });
    }

    return items;
  }, [currentPage, totalPage]);

  return (
    <div className="flex justify-center items-center">
      <span
        className={classnames("paginationItem", {
          disabled: currentPage === 1,
        })}
        onClick={() => {
          if (currentPage !== 1) {
            onChange(currentPage - 1);
          }
        }}
      >
        {t("prev_page")}
      </span>
      {paginationItems.map((item, index) => (
        <span
          key={index}
          className={classnames(
            "paginationItem",
            {
              active: currentPage === item.page,
            },
            {
              disabled: item.disabled,
            }
          )}
          onClick={() => {
            if (!item.disabled) {
              onChange(item.page as number);
            }
          }}
        >
          {item.page}
        </span>
      ))}
      <span
        className={classnames("paginationItem", {
          disabled: currentPage === totalPage,
        })}
        onClick={() => {
          if (currentPage !== totalPage) {
            onChange(currentPage + 1);
          }
        }}
      >
        {t("next_page")}
      </span>
    </div>
  );
};

export default Pagination;

import * as React from "react"
import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon } from "lucide-react"
import { RemoveScroll } from "react-remove-scroll"

import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

type SearchableSelectOption = {
  value: string
  label: string
  /** Fields matched by the search but not shown in the row: an address, a port, a group name. */
  searchTerms?: string[]
}

function SearchableSelect({
  value,
  onValueChange,
  options,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  onCreateOption,
  createOptionLabel,
  className,
}: {
  value?: string
  onValueChange: (value: string) => void
  options: SearchableSelectOption[]
  placeholder: string
  searchPlaceholder?: string
  emptyLabel: string
  /** Offers creating the typed value when the search finds nothing. */
  onCreateOption?: (value: string) => void
  createOptionLabel?: (value: string) => string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [activeIndex, setActiveIndex] = React.useState(0)
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const optionRefs = React.useRef<(HTMLButtonElement | null)[]>([])

  const selected = options.find((option) => option.value === value)

  const filteredOptions = React.useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    if (!normalizedQuery) return options
    // Hosts are searched by more than their name: a jump host is remembered by its address or by the
    // group it lives in, and neither fits into the label without making the row unreadable.
    return options.filter((option) =>
      [option.label, ...(option.searchTerms ?? [])].some((field) =>
        field.toLocaleLowerCase().includes(normalizedQuery)
      )
    )
  }, [options, query])

  const trimmedQuery = query.trim()
  const canCreate = !!onCreateOption && trimmedQuery.length > 0 && filteredOptions.length === 0

  React.useEffect(() => {
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      const selectedIndex = options.findIndex((option) => option.value === value)
      setQuery("")
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0)
    }
    setOpen(nextOpen)
  }

  const selectOption = (optionValue: string) => {
    onValueChange(optionValue)
    setOpen(false)
  }

  const createOption = () => {
    if (!canCreate) return
    onCreateOption?.(trimmedQuery)
    setOpen(false)
  }

  const handleSearchChange = (nextQuery: string) => {
    setQuery(nextQuery)
    setActiveIndex(0)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && filteredOptions.length > 0) {
      event.preventDefault()
      setActiveIndex((index) => Math.min(index + 1, filteredOptions.length - 1))
    } else if (event.key === "ArrowUp" && filteredOptions.length > 0) {
      event.preventDefault()
      setActiveIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === "Enter" && filteredOptions[activeIndex]) {
      event.preventDefault()
      selectOption(filteredOptions[activeIndex].value)
    } else if (event.key === "Enter" && canCreate) {
      event.preventDefault()
      createOption()
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange} modal={false}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          data-slot="searchable-select-trigger"
          className={cn(
            "flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 text-sm whitespace-nowrap transition-colors outline-none select-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            selected ? "text-foreground" : "text-muted-foreground",
            className
          )}
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronDownIcon className="size-4 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-slot="searchable-select-content"
        align="start"
        side="bottom"
        avoidCollisions={false}
        className="w-(--radix-popover-trigger-width) min-w-56 gap-1.5 p-1.5"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchInputRef.current?.focus()
        }}
      >
        <div className="relative">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(event) => handleSearchChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={searchPlaceholder ?? placeholder}
            className="h-8 border-border bg-input/50 pl-8"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div role="listbox">
          {/* Radix locks scrolling outside of the dialog content with an unconditional
              preventDefault, so this popup needs its own lock to sit on top of it, the same way
              SelectContent brings its own. Without it the wheel does nothing here. */}
          <RemoveScroll
            className="flex max-h-56 flex-col gap-0.5 overflow-y-auto"
            removeScrollBar={false}
          >
            {filteredOptions.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</p>
            ) : (
              filteredOptions.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  ref={(element) => {
                    optionRefs.current[index] = element
                  }}
                  aria-selected={option.value === value}
                  data-active={index === activeIndex ? "" : undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => selectOption(option.value)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors outline-none data-[active]:bg-muted",
                    option.value === value && "font-medium"
                  )}
                >
                  <CheckIcon
                    className={cn(
                      "size-4 shrink-0 text-primary",
                      option.value !== value && "invisible"
                    )}
                  />
                  <span className="truncate">{option.label}</span>
                </button>
              ))
            )}
            {canCreate && (
              <button
                type="button"
                onClick={createOption}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium text-primary transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <PlusIcon className="size-4 shrink-0"/>
                <span className="truncate">{createOptionLabel?.(trimmedQuery) ?? trimmedQuery}</span>
              </button>
            )}
          </RemoveScroll>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export { SearchableSelect, type SearchableSelectOption }
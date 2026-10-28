import * as React from "react"
import {Eye, EyeOff} from "lucide-react";
import {useTranslation} from "react-i18next";
import {Input} from "@/components/ui/input"
import {cn} from "@/lib/utils"

function PasswordInput({className, ...props}: React.ComponentProps<"input">) {
  const [visible, setVisible] = React.useState(false)
  const {t} = useTranslation("common")

  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        className={cn("pr-8", className)}
        {...props}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? t("hide_password") : t("show_password")}
        title={visible ? t("hide_password") : t("show_password")}
        className="absolute inset-y-0 right-1.5 my-auto flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
      >
        {visible ? <EyeOff className="size-4"/> : <Eye className="size-4"/>}
      </button>
    </div>
  )
}

export { PasswordInput }

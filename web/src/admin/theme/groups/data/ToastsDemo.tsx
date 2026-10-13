import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Button, ToastProvider, useToast } from "@ui"
import { AlertCircle, Bell, CheckCircle2, Undo2 } from "lucide-react"
import PreviewStage from "../../PreviewStage"

/** Buttons that fire toasts — confined to a bounded stage. */
function ToastButtons() {
  const { t } = useTranslation()
  const toast = useToast()
  const [count, setCount] = useState(0)

  return (
    <div className="flex flex-wrap items-start gap-2 p-3">
      <Button size="sm" variant="secondary" icon={<CheckCircle2 size={14} />}
              onClick={() => toast.success(t('admin.t_prev_to_ok', { defaultValue: 'Paramètres enregistrés.' }))}>
        {t('admin.t_prev_to_b_ok', { defaultValue: 'Succès' })}
      </Button>
      <Button size="sm" variant="secondary" icon={<Bell size={14} />}
              onClick={() => toast.info(t('admin.t_prev_to_info', { defaultValue: 'Import lancé en arrière-plan.' }))}>
        {t('admin.t_prev_to_b_info', { defaultValue: 'Info' })}
      </Button>
      <Button size="sm" variant="secondary" icon={<AlertCircle size={14} />}
              onClick={() => toast.error(
                t('admin.t_prev_to_err', { defaultValue: 'Impossible de contacter le module.' }),
                { title: t('admin.t_prev_to_err_t', { defaultValue: 'Échec' }) },
              )}>
        {t('admin.t_prev_to_b_err', { defaultValue: 'Erreur' })}
      </Button>
      <Button size="sm" variant="secondary" icon={<Undo2 size={14} />}
              onClick={() => {
                const n = count + 1
                setCount(n)
                toast.toast({
                  message: t('admin.t_prev_to_undo', { defaultValue: 'Élément supprimé.' }),
                  action: { label: t('admin.t_prev_to_undo_a', { defaultValue: 'Annuler' }), onClick: () => {} },
                  duration: 8000,
                })
              }}>
        {t('admin.t_prev_to_b_undo', { defaultValue: 'Avec action' })} {count > 0 && `(${count})`}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => toast.dismissAll()}>
        {t('admin.t_prev_to_b_clear', { defaultValue: 'Tout fermer' })}
      </Button>
    </div>
  )
}

/** Transient notifications, stacked inside their own bounded stage. */
export function ToastsDemo() {
  const { t } = useTranslation()
  return (
    <PreviewStage title={t('admin.t_prev_toasts', { defaultValue: 'Notifications transitoires' })} width={420} height={300}>
      {/* One provider per stage: the toasts portal into the stage (PortalHostContext)
          instead of <body>, so they stay inside the preview. */}
      <ToastProvider t={t}>
        <ToastButtons />
      </ToastProvider>
    </PreviewStage>
  )
}

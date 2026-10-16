//! The two questions every app asks, in Kubuno's style: [`ConfirmBox`] (a choice between two or three answers) and
//! [`InputBox`] (one line of text). Every string comes from the caller (its own translated resources); never a system
//! message box.
//!
//! Closing a [`ConfirmBox`] (Escape, the close box, Alt+F4) is [`Answer::Dismissed`], never the second answer: the
//! second answer of a confirmation is often destructive (discard a crash copy, overwrite the server version), and a
//! dismissal must not pick it.

use kubuno_desktop_controls::host::{self, FormBorderStyle, StartPosition};

use crate::forms::{AsForm, Button, Control, DialogResult, Form, Label, TextField, WindowKind};
use crate::{Anchor, MessageBoxIcon};

/// What the user did with a [`ConfirmBox`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    /// The first (primary, confirming) answer.
    First,
    /// The second answer, clicked.
    Second,
    /// The third answer, when there is one.
    Other,
    /// Closed without answering.
    Dismissed,
}

impl Answer {
    /// The answer a dialog result stands for: the confirming button closes with `Ok`, the second with `No`, the third
    /// with `Retry`; anything else (a dismissal) is [`Answer::Dismissed`].
    pub fn of(result: DialogResult) -> Self {
        match result {
            DialogResult::Ok => Answer::First,
            DialogResult::No => Answer::Second,
            DialogResult::Retry => Answer::Other,
            _ => Answer::Dismissed,
        }
    }
}

const PAD: f32 = 24.0;
const GLYPH: f32 = 40.0;
const LINE: f32 = 20.0;
const BUTTON_H: f32 = 36.0;

/// The height of `text` wrapped in a column `width` wide (about 6.6 DIP per character at the body size, plus the
/// explicit line breaks).
fn wrapped_height(text: &str, width: f32) -> f32 {
    let per_line = ((width / 6.6) as usize).max(20);
    let lines: usize = text.split('\n').map(|l| l.chars().count().div_ceil(per_line).max(1)).sum();
    lines as f32 * LINE
}

/// A button wide enough for its caption (at least the footer's 96 DIP).
fn action_button(name: &str, text: &str, variant: &str, result: DialogResult) -> Button {
    let width = (text.chars().count() as f32 * 7.5 + 32.0).max(96.0);
    Button::new()
        .name(name)
        .text(text)
        .bounds(0.0, 0.0, width, BUTTON_H)
        .property("ActionBar.Region", "Right")
        .variant(variant)
        .dialog_result(result)
}

fn dialog_form(title: &str, width: f32, height: f32) -> Form {
    Form::new()
        .text(if title.is_empty() { host::diagnostics::exe_name() } else { title.to_string() })
        .client_size(width, height)
        .window_kind(WindowKind::Dialog)
        .start_position(StartPosition::CenterParent)
        .form_border_style(FormBorderStyle::FixedDialog)
        .maximize_box(false)
        .minimize_box(false)
        .property("ShowInTaskbar", false)
}

fn owner_handle(owner: &dyn AsForm) -> Option<isize> {
    owner.as_form().handle().or_else(|| host::main_window().map(|h| h.0 as isize))
}

/// A question with two (or three) answers, every caption given by the caller:
///
/// ```no_run
/// use kubuno_desktop::prelude::*;
/// # fn f(owner: &dyn AsForm) {
/// match ConfirmBox::new("Document", "Restore the copy kept on this PC?").confirm("Restore").decline("Discard").show_owned(owner) {
///     Answer::First => { /* restore */ }
///     Answer::Second => { /* discard: destructive */ }
///     _ => { /* dismissed: do nothing */ }
/// }
/// # }
/// ```
#[derive(Clone, Debug)]
pub struct ConfirmBox {
    title: String,
    message: String,
    confirm: String,
    decline: Option<String>,
    other: Option<String>,
    icon: MessageBoxIcon,
    width: f32,
}

impl ConfirmBox {
    /// A question titled `title`, asking `message`, answered by "OK" until [`Self::confirm`] names the answer.
    pub fn new(title: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            message: message.into(),
            confirm: "OK".into(),
            decline: None,
            other: None,
            icon: MessageBoxIcon::Warning,
            width: 480.0,
        }
    }

    /// The caption of the first (confirming) answer.
    pub fn confirm(mut self, text: impl Into<String>) -> Self {
        self.confirm = text.into();
        self
    }

    /// The caption of the second answer.
    pub fn decline(mut self, text: impl Into<String>) -> Self {
        self.decline = Some(text.into());
        self
    }

    /// The caption of a third answer ([`Answer::Other`]).
    pub fn other(mut self, text: impl Into<String>) -> Self {
        self.other = Some(text.into());
        self
    }

    /// The glyph beside the message (a warning triangle by default; [`MessageBoxIcon::Danger`] also turns the
    /// confirming answer red).
    pub fn icon(mut self, icon: MessageBoxIcon) -> Self {
        self.icon = icon;
        self
    }

    /// The dialog's width in DIP (480 by default).
    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }

    /// The dialog, not shown: the glyph, the message beside it, the answers on the right of the action bar (the
    /// confirming one last, and the window's accept button). It has no cancel button: Escape closes it unanswered.
    pub fn build(&self) -> Form {
        let has_glyph = self.icon != MessageBoxIcon::None;
        let text_x = if has_glyph { PAD + GLYPH + 16.0 } else { PAD };
        let text_w = self.width - text_x - PAD;
        let text_h = wrapped_height(&self.message, text_w).max(if has_glyph { GLYPH } else { LINE });
        let height = PAD + text_h + PAD + kubuno_desktop_controls::window_chrome::FOOTER_HEIGHT;
        let form = dialog_form(&self.title, self.width, height);
        if let Some((name, disc)) = glyph(self.icon) {
            let icon = Control::new("Icon");
            icon.set_property("Name", name);
            icon.set_property("Size", GLYPH);
            icon.set_property("Disc", disc);
            icon.set_bounds(PAD, PAD, GLYPH, GLYPH);
            form.controls().add(&icon);
        }
        let label = Label::new()
            .name("message")
            .text(self.message.as_str())
            .bounds(text_x, PAD, text_w, text_h)
            .anchor(Anchor::TOP | Anchor::LEFT | Anchor::RIGHT)
            .property("Overflow", "Wrap");
        form.controls().add(&label);
        if let Some(other) = &self.other {
            form.controls().add(&action_button("other", other, "Secondary", DialogResult::Retry));
        }
        if let Some(decline) = &self.decline {
            form.controls().add(&action_button("decline", decline, "Secondary", DialogResult::No));
        }
        let variant = if self.icon == MessageBoxIcon::Danger { "Danger" } else { "Primary" };
        let confirm = action_button("confirm", &self.confirm, variant, DialogResult::Ok);
        form.controls().add(&confirm);
        form.set_accept_button(&confirm);
        form
    }

    /// Ask, owned by the active window, and return what the user did.
    pub fn show(&self) -> Answer {
        let owner = host::main_window().map(|h| h.0 as isize);
        Answer::of(crate::application::show_dialog(&mut self.build(), owner))
    }

    /// Ask over `owner` and return what the user did.
    pub fn show_owned(&self, owner: &dyn AsForm) -> Answer {
        Answer::of(crate::application::show_dialog(&mut self.build(), owner_handle(owner)))
    }
}

/// The glyph and the disc of a confirmation's icon.
fn glyph(icon: MessageBoxIcon) -> Option<(&'static str, &'static str)> {
    match icon {
        MessageBoxIcon::None => None,
        MessageBoxIcon::Information => Some(("Info", "Info")),
        MessageBoxIcon::Warning => Some(("AlertTriangle", "Warning")),
        MessageBoxIcon::Error => Some(("AlertCircle", "Danger")),
        MessageBoxIcon::Question => Some(("HelpCircle", "Neutral")),
        MessageBoxIcon::Danger => Some(("Trash2", "Danger")),
    }
}

/// One line of text asked with a title and an optional message (the web's `prompt()`, never the browser's):
///
/// ```no_run
/// use kubuno_desktop::prelude::*;
/// # fn f(owner: &dyn AsForm) {
/// if let Some(name) = InputBox::new("Rename").message("New name of the sheet").value("Sheet1").cancel("Cancel").ask_owned(owner) {
///     // …
/// }
/// # }
/// ```
#[derive(Clone, Debug)]
pub struct InputBox {
    title: String,
    message: String,
    value: String,
    placeholder: String,
    confirm: String,
    cancel: String,
    allow_empty: bool,
    width: f32,
}

impl InputBox {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            message: String::new(),
            value: String::new(),
            placeholder: String::new(),
            confirm: "OK".into(),
            cancel: "Cancel".into(),
            allow_empty: false,
            width: 440.0,
        }
    }

    /// The line above the field.
    pub fn message(mut self, text: impl Into<String>) -> Self {
        self.message = text.into();
        self
    }

    /// The text the field starts with.
    pub fn value(mut self, text: impl Into<String>) -> Self {
        self.value = text.into();
        self
    }

    /// The hint shown in the empty field.
    pub fn placeholder(mut self, text: impl Into<String>) -> Self {
        self.placeholder = text.into();
        self
    }

    /// The caption of the confirming button ("OK" by default).
    pub fn confirm(mut self, text: impl Into<String>) -> Self {
        self.confirm = text.into();
        self
    }

    /// The caption of the cancelling button ("Cancel" by default: pass the translated one).
    pub fn cancel(mut self, text: impl Into<String>) -> Self {
        self.cancel = text.into();
        self
    }

    /// Accept an empty answer (refused by default: an empty answer is then `None`).
    pub fn allow_empty(mut self, allow: bool) -> Self {
        self.allow_empty = allow;
        self
    }

    /// The dialog's width in DIP (440 by default).
    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }

    /// The dialog, not shown: the message, the field (named `value_box`), Cancel and the confirming button.
    pub fn build(&self) -> Form {
        let text_w = self.width - 2.0 * PAD;
        let message_h = if self.message.is_empty() { 0.0 } else { wrapped_height(&self.message, text_w) };
        let field_y = if self.message.is_empty() { PAD - 4.0 } else { PAD - 4.0 + message_h + 4.0 };
        let height = field_y + 32.0 + PAD + kubuno_desktop_controls::window_chrome::FOOTER_HEIGHT;
        let form = dialog_form(&self.title, self.width, height);
        if !self.message.is_empty() {
            let label = Label::new()
                .name("message")
                .text(self.message.as_str())
                .bounds(PAD, PAD - 4.0, text_w, message_h)
                .anchor(Anchor::TOP | Anchor::LEFT | Anchor::RIGHT)
                .property("Overflow", "Wrap");
            form.controls().add(&label);
        }
        let field = TextField::new()
            .name("value_box")
            .text(self.value.as_str())
            .placeholder(self.placeholder.as_str())
            .bounds(PAD, field_y, text_w, 32.0)
            .anchor(Anchor::TOP | Anchor::LEFT | Anchor::RIGHT);
        form.controls().add(&field);
        let cancel = action_button("cancel", &self.cancel, "Secondary", DialogResult::Cancel);
        form.controls().add(&cancel);
        form.set_cancel_button(&cancel);
        let ok = action_button("ok", &self.confirm, "Primary", DialogResult::Ok);
        form.controls().add(&ok);
        form.set_accept_button(&ok);
        form
    }

    /// Ask, owned by the active window: the trimmed answer, `None` when cancelled (or empty unless allowed).
    pub fn ask(&self) -> Option<String> {
        self.run(host::main_window().map(|h| h.0 as isize))
    }

    /// Ask over `owner`: the trimmed answer, `None` when cancelled (or empty unless allowed).
    pub fn ask_owned(&self, owner: &dyn AsForm) -> Option<String> {
        self.run(owner_handle(owner))
    }

    fn run(&self, owner: Option<isize>) -> Option<String> {
        let mut form = self.build();
        if crate::application::show_dialog(&mut form, owner) != DialogResult::Ok {
            return None;
        }
        let value = form.controls().find("value_box").map(|c| c.get_text()).unwrap_or_default();
        let value = value.trim().to_string();
        (self.allow_empty || !value.is_empty()).then_some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dismissal_is_never_the_second_answer() {
        assert_eq!(Answer::of(DialogResult::Ok), Answer::First);
        assert_eq!(Answer::of(DialogResult::No), Answer::Second);
        assert_eq!(Answer::of(DialogResult::Retry), Answer::Other);
        assert_eq!(Answer::of(DialogResult::Cancel), Answer::Dismissed);
        assert_eq!(Answer::of(DialogResult::None), Answer::Dismissed);
    }

    #[test]
    fn long_messages_grow_the_dialog() {
        assert!(wrapped_height(&"word ".repeat(80), 356.0) > wrapped_height("short", 356.0));
        assert_eq!(wrapped_height("a\nb", 356.0), 2.0 * LINE);
    }
}

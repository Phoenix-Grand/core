//! The standalone demo iOS app (feature `standalone`): the renderer's sample screen, to try the engine and the
//! shell without any module. A module's own iOS crate provides its own `main` and calls
//! [`kubuno_mobile_shell_ios::run`] with its app.

fn main() {
    kubuno_mobile_shell_ios::run(kubuno_mobile_render::SAMPLE_APP);
}

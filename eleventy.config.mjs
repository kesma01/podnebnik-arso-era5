import SolidPlugin from "vite-plugin-solid";
import TailwindCSS from "@tailwindcss/vite";
import EleventyVitePlugin from "@11ty/eleventy-plugin-vite";

export default function (eleventyConfig) {
    const datasette = process.env.VITE_DATASETTE_URL || "https://podnebnik.kesma.wtf";
    const vremenar  = process.env.VITE_VREMENAR_URL  || "https://podnebnik.vremenar.app";

    eleventyConfig.addPlugin(EleventyVitePlugin, {
        viteOptions: {
            plugins: [
                TailwindCSS(),
                SolidPlugin(),
            ],
            define: {
                // inject at build time so same-origin prod paths work out of the box
                "import.meta.env.VITE_DATASETTE_URL": JSON.stringify(""),
                "import.meta.env.VITE_VREMENAR_URL":  JSON.stringify(""),
            },
            server: {
                proxy: {
                    "/datasette": {
                        target:       datasette,
                        changeOrigin: true,
                    },
                    "/vremenar": {
                        target:       vremenar,
                        changeOrigin: true,
                        rewrite:      (path) => path.replace(/^\/vremenar/, "/staging"),
                    },
                },
            },
        }
    });

    eleventyConfig.addPassthroughCopy("code");
    eleventyConfig.addPassthroughCopy("styles");
    eleventyConfig.addPassthroughCopy("assets");

    return {
        dir: {
            input:  "pages",
            output: "dist",
        },
        htmlTemplateEngine:     "liquid",
        markdownTemplateEngine: "liquid",
    };
}

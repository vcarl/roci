import { readFileSync } from "node:fs"
import { parseFrontmatter, renderTemplate } from "../core/template.js"

export interface LoadedSkill {
  readonly name: string
  readonly description: string
  readonly template: string
  readonly render: (vars: Record<string, string>) => string
}

export function loadSkillSync(filePath: string): LoadedSkill {
  const raw = readFileSync(filePath, "utf-8")
  const { meta, body } = parseFrontmatter(raw)
  const name = (meta.name as string) ?? ""
  const description = (meta.description as string) ?? ""
  return {
    name,
    description,
    template: body,
    render: (vars: Record<string, string>) => renderTemplate(body, vars),
  }
}

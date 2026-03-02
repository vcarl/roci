import { Context } from "effect"

export class ProjectRoot extends Context.Tag("ProjectRoot")<ProjectRoot, string>() {}

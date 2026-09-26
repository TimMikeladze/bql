import { Container } from "@cloudflare/containers"
import { containerEnvironment, routeRequest, type ContainerNamespace, type DeploymentEnvironment } from "./routing.ts"

type Env = DeploymentEnvironment & { DATABASE: ContainerNamespace }

export class DatabaseContainer extends Container<Env> {
  defaultPort = 8080
  sleepAfter = "5m"
  envVars = containerEnvironment(this.env)
}

export default { fetch: routeRequest }

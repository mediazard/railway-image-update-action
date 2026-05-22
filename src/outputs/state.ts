/**
 * Mutable accumulator for deploy results. Owned by the main entry point;
 * passed to `writeOutputs` at the end (success or failure) to render the
 * four GitHub Action outputs.
 *
 * `markDeployed` and `attachDeploymentId` are deliberately separate —
 * split for partial-failure attribution: some Railway redeploy calls
 * return a `null` deployment id even on success, and a label may be
 * marked deployed without ever recording an id.
 */
export class DeployState {
  readonly labels: readonly string[];
  private readonly deployed = new Set<string>();
  private readonly deploymentIds: Array<{ label: string; id: string }> = [];
  imageTag?: string;

  constructor(labels: readonly string[]) {
    this.labels = labels;
  }

  static empty(): DeployState {
    return new DeployState([]);
  }

  /** Marks the label as successfully deployed. Idempotent. */
  markDeployed(label: string): void {
    this.deployed.add(label);
  }

  /** Records a deployment ID (separate from markDeployed — some deploys return null id). */
  attachDeploymentId(label: string, id: string): void {
    this.deploymentIds.push({ label, id });
  }

  /** Deployed labels, in input order. */
  deployedLabels(): string[] {
    return this.labels.filter((l) => this.deployed.has(l));
  }

  /** Labels that did NOT deploy, in input order. */
  failedLabels(): string[] {
    return this.labels.filter((l) => !this.deployed.has(l));
  }

  /** Immutable view of recorded deployment IDs. */
  ids(): ReadonlyArray<{ readonly label: string; readonly id: string }> {
    return this.deploymentIds;
  }
}

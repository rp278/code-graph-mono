import Brand from './Brand';
import { isFeatureDevelopmentEnabled } from '../flags';

const OPTIONS = [
  {
    id: 'ask',
    title: 'Ask AI',
    blurb: 'Ask anything about the code. Answers come from the graph and the real files.',
  },
  {
    id: 'bugs',
    title: 'Fix Bugs',
    blurb: 'Describe what broke. The pipeline traces it, patches it, and verifies.',
  },
  {
    id: 'features',
    title: 'Feature Development',
    blurb: 'Turn a plain-English requirement into gated, cross-repo PRs.',
    // Shown only when the cg_feature_development_enabled cookie is "true".
    enabled: isFeatureDevelopmentEnabled,
  },
  {
    id: 'graph',
    title: 'View Graph',
    blurb: 'Explore how your repos, files, and APIs actually connect.',
  },
];

export default function Landing({ onChoose }) {
  const options = OPTIONS.filter((opt) => !opt.enabled || opt.enabled());
  return (
    <div className="landing">
      <div className="landing-bg" aria-hidden="true">
        <div className="landing-orb landing-orb-a" />
        <div className="landing-orb landing-orb-b" />
        <div className="landing-orb landing-orb-c" />
        <div className="landing-grid" />
        <div className="landing-particles" />
      </div>

      <div className="landing-frame">
        <div className="landing-left">
          <Brand size="lg" />
          <p className="landing-lede">
            One workspace for seeing the system, shipping features, and closing bugs —
            grounded in the live knowledge graph.
          </p>
        </div>

        <div className="landing-rule" aria-hidden="true" />

        <nav className="landing-right" aria-label="Workspace">
          {options.map((opt) => (
            <button
              key={opt.id}
              type="button"
              className="landing-option"
              onClick={() => onChoose(opt.id)}
            >
              <span className="landing-option-body">
                <span className="landing-option-title">{opt.title}</span>
                <span className="landing-option-blurb">{opt.blurb}</span>
              </span>
              <span className="landing-option-arrow" aria-hidden="true">
                →
              </span>
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

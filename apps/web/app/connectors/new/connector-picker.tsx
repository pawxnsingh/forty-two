import { ArrowRight } from "lucide-react";
import Link from "next/link";
import {
  connectorGroups,
  connectors,
  type ConnectorDefinition,
} from "../connector-registry";
import styles from "../connectors.module.css";

const featuredTypes = ["postgresql", "csv", "snowflake"] as const;

function ConnectorIcon({ connector }: { connector: ConnectorDefinition }) {
  const Icon = connector.icon;
  return (
    <span className={styles.connectorIcon} data-connector={connector.type}>
      <Icon aria-hidden="true" />
    </span>
  );
}

export function ConnectorPicker() {
  const featured = featuredTypes
    .map((type) => connectors.find((connector) => connector.type === type))
    .filter((connector): connector is ConnectorDefinition =>
      Boolean(connector),
    );

  return (
    <div className={`${styles.page} ${styles.marketplacePage}`}>
      <section
        className={styles.connectorHero}
        aria-label="Featured connectors"
      >
        <div className={styles.connectorHeroIcons}>
          {featured.map((connector) => (
            <Link
              aria-label={`Connect ${connector.label}`}
              href={`/connectors/new/${connector.type}`}
              key={connector.type}
              title={`Connect ${connector.label}`}
            >
              <ConnectorIcon connector={connector} />
              <span>{connector.label}</span>
            </Link>
          ))}
        </div>
      </section>

      <div className={styles.marketplaceResults}>
        {connectorGroups.map((group) => (
          <section className={styles.marketplaceGroup} key={group.id}>
            <div className={styles.marketplaceGroupHeading}>
              <h2>{group.label}</h2>
            </div>
            <div className={styles.marketplaceList}>
              {group.connectors.map((connector) => (
                <Link
                  className={styles.marketplaceRow}
                  href={`/connectors/new/${connector.type}`}
                  key={connector.type}
                >
                  <ConnectorIcon connector={connector} />
                  <span className={styles.marketplaceRowCopy}>
                    <strong>{connector.label}</strong>
                    <span>{connector.description}</span>
                  </span>
                  <span className={styles.marketplaceAdd}>
                    <span>Connect</span>
                    <ArrowRight aria-hidden="true" />
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

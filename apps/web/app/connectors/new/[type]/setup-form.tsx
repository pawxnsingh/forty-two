"use client";

import { Button, Checkbox, FileDropZone, TextField } from "@repo/ui-web";
import { ArrowLeft, Check, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import {
  connectorDefinition,
  isFileConnector,
  type ConnectorType,
} from "../../connector-registry";
import styles from "../../connectors.module.css";
import type { ApiErrorPayload, PublicDataSource } from "../../types";

const fileTypes = {
  csv: ["text/csv", "application/csv", "application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
} as const;

function required(form: FormData, name: string) {
  return String(form.get(name) ?? "").trim();
}

function optional(form: FormData, name: string) {
  const result = required(form, name);
  return result || undefined;
}

function integer(form: FormData, name: string) {
  return Number(required(form, name));
}

async function responseMessage(response: Response, fallback: string) {
  const payload = (await response
    .json()
    .catch(() => null)) as ApiErrorPayload | null;
  return payload?.error?.message ?? fallback;
}

function FormSection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <section className={styles.formSection}>
      <div className={styles.formSectionHeading}>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      <div className={styles.fieldGrid}>{children}</div>
    </section>
  );
}

function DatabaseFields({
  type,
}: {
  type: Exclude<ConnectorType, "csv" | "xlsx">;
}) {
  if (type === "snowflake") {
    return (
      <>
        <FormSection
          description="Identify the warehouse and data scope to expose."
          title="Connection"
        >
          <TextField
            isRequired
            label="Account identifier"
            name="accountId"
            placeholder="xy12345.us-east-1"
          />
          <TextField
            isRequired
            label="Warehouse"
            name="warehouseId"
            placeholder="COMPUTE_WH"
          />
          <TextField
            isRequired
            label="Database"
            name="database"
            placeholder="ANALYTICS"
          />
          <TextField label="Schema" name="schema" placeholder="PUBLIC" />
          <TextField label="Role" name="role" placeholder="ANALYST" />
        </FormSection>
        <FormSection
          description="Use a dedicated read-only Snowflake user."
          title="Credentials"
        >
          <TextField
            isRequired
            label="Username"
            name="username"
            autoComplete="username"
          />
          <TextField
            isRequired
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
          />
        </FormSection>
      </>
    );
  }

  if (type === "bigquery") {
    return (
      <>
        <FormSection
          description="Choose the Google Cloud project Forty Two can query."
          title="Project"
        >
          <TextField
            isRequired
            label="Project ID"
            name="projectId"
            placeholder="my-gcp-project"
          />
          <TextField
            defaultValue="US"
            isRequired
            label="Location"
            name="location"
          />
        </FormSection>
        <FormSection
          description="Paste the values from your service-account JSON key."
          title="Service account"
        >
          <TextField
            className={styles.fieldWide}
            isRequired
            label="Service-account email"
            name="clientEmail"
            type="email"
            placeholder="service-account@project.iam.gserviceaccount.com"
          />
          <label className={`${styles.nativeField} ${styles.fieldWide}`}>
            <span>Private key</span>
            <textarea
              name="privateKey"
              placeholder="-----BEGIN PRIVATE KEY-----"
              required
            />
          </label>
          <TextField label="Private-key ID" name="privateKeyId" />
          <TextField label="Client ID" name="clientId" />
        </FormSection>
      </>
    );
  }

  const defaults = {
    postgresql: { port: 5432, database: "postgres" },
    mysql: { port: 3306, database: "" },
    sqlserver: { port: 1433, database: "" },
    redshift: { port: 5439, database: "dev" },
  }[type];

  return (
    <>
      <FormSection
        description="Enter the network address and database scope."
        title="Connection"
      >
        <TextField
          isRequired
          label="Host"
          name="host"
          placeholder="database.example.com"
        />
        <TextField
          defaultValue={String(defaults.port)}
          isRequired
          label="Port"
          name="port"
          type="number"
        />
        <TextField
          defaultValue={defaults.database}
          isRequired
          label="Database"
          name="database"
        />
        {type === "mysql" ? (
          <TextField
            label="Character set"
            name="charset"
            placeholder="utf8mb4"
          />
        ) : (
          <TextField label="Schema" name="schema" placeholder="public" />
        )}
        {type === "sqlserver" ? (
          <TextField label="Instance" name="instance" />
        ) : null}
        {type === "redshift" ? (
          <TextField label="Cluster identifier" name="clusterIdentifier" />
        ) : null}
      </FormSection>
      <FormSection
        description="Use a database user with read-only access."
        title="Credentials"
      >
        <TextField
          isRequired
          label="Username"
          name="username"
          autoComplete="username"
        />
        <TextField
          isRequired
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
        />
        {type === "sqlserver" ? (
          <TextField label="Domain" name="domain" />
        ) : null}
      </FormSection>
      <FormSection title="Security">
        {type === "postgresql" || type === "mysql" ? (
          <label className={styles.nativeField}>
            <span>SSL mode</span>
            <select defaultValue="verify-full" name="sslMode">
              <option value="verify-full">Verify full</option>
              <option value="verify-ca">Verify certificate authority</option>
              <option value="require">Require encryption</option>
              <option value="disable">Disable</option>
            </select>
          </label>
        ) : null}
        {type === "sqlserver" ? (
          <div className={`${styles.checkboxStack} ${styles.fieldWide}`}>
            <Checkbox defaultSelected name="encrypt">
              Encrypt connection
            </Checkbox>
            <Checkbox name="trustServerCertificate">
              Trust server certificate
            </Checkbox>
          </div>
        ) : null}
        {type === "redshift" ? (
          <Checkbox defaultSelected name="ssl">
            Require SSL
          </Checkbox>
        ) : null}
      </FormSection>
    </>
  );
}

function databaseRequest(
  type: Exclude<ConnectorType, "csv" | "xlsx">,
  form: FormData,
) {
  const common = {
    connectorType: type,
    name: required(form, "name"),
    mutationMode: "disabled",
    mutationAllowlist: [],
  };

  switch (type) {
    case "postgresql":
      return {
        ...common,
        config: {
          host: required(form, "host"),
          port: integer(form, "port"),
          database: required(form, "database"),
          schema: optional(form, "schema"),
          sslMode: required(form, "sslMode"),
          connectionTimeoutMs: 10_000,
        },
        credentials: {
          username: required(form, "username"),
          password: required(form, "password"),
        },
      };
    case "mysql":
      return {
        ...common,
        config: {
          host: required(form, "host"),
          port: integer(form, "port"),
          database: required(form, "database"),
          charset: optional(form, "charset"),
          sslMode: required(form, "sslMode"),
          connectionTimeoutMs: 10_000,
        },
        credentials: {
          username: required(form, "username"),
          password: required(form, "password"),
        },
      };
    case "sqlserver":
      return {
        ...common,
        config: {
          host: required(form, "host"),
          port: integer(form, "port"),
          database: required(form, "database"),
          instance: optional(form, "instance"),
          encrypt: form.has("encrypt"),
          trustServerCertificate: form.has("trustServerCertificate"),
          connectionTimeoutMs: 10_000,
          requestTimeoutMs: 60_000,
        },
        credentials: {
          username: required(form, "username"),
          password: required(form, "password"),
          domain: optional(form, "domain"),
        },
      };
    case "snowflake":
      return {
        ...common,
        config: {
          accountId: required(form, "accountId"),
          warehouseId: required(form, "warehouseId"),
          database: required(form, "database"),
          schema: optional(form, "schema"),
          role: optional(form, "role"),
          connectionTimeoutMs: 10_000,
        },
        credentials: {
          username: required(form, "username"),
          password: required(form, "password"),
        },
      };
    case "bigquery":
      return {
        ...common,
        config: {
          projectId: required(form, "projectId"),
          location: required(form, "location"),
          connectionTimeoutMs: 10_000,
        },
        credentials: {
          serviceAccount: {
            clientEmail: required(form, "clientEmail"),
            privateKey: required(form, "privateKey"),
            privateKeyId: optional(form, "privateKeyId"),
            clientId: optional(form, "clientId"),
          },
        },
      };
    case "redshift":
      return {
        ...common,
        config: {
          host: required(form, "host"),
          port: integer(form, "port"),
          database: required(form, "database"),
          schema: optional(form, "schema"),
          ssl: form.has("ssl"),
          clusterIdentifier: optional(form, "clusterIdentifier"),
          connectionTimeoutMs: 10_000,
        },
        credentials: {
          username: required(form, "username"),
          password: required(form, "password"),
        },
      };
  }
}

export function ConnectorSetupForm({ type }: { type: ConnectorType }) {
  const router = useRouter();
  const connector = connectorDefinition(type)!;
  const Icon = connector.icon;
  const fileConnector = isFileConnector(type);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function selectFile(files: File[]) {
    const selected = files[0];
    if (!selected) return;
    const expectedExtension = type === "csv" ? ".csv" : ".xlsx";
    if (!selected.name.toLowerCase().endsWith(expectedExtension)) {
      setError(`Choose a ${expectedExtension} file.`);
      return;
    }
    setFile(selected);
    setName((current) => current || selected.name.replace(/\.[^.]+$/, ""));
    setError(null);
  }

  async function submitFile() {
    if (!file || !name.trim() || !fileConnector)
      throw new Error("Choose a file and enter a connector name.");
    const mimeType =
      file.type ||
      (type === "csv"
        ? "text/csv"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const initiateResponse = await fetch("/api/data-sources/files/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        filename: file.name,
        mimeType,
        fileSizeBytes: file.size,
      }),
    });
    if (!initiateResponse.ok)
      throw new Error(
        await responseMessage(
          initiateResponse,
          "The upload could not be started.",
        ),
      );
    const initiated = (await initiateResponse.json()) as {
      data: PublicDataSource;
      upload: { headers: Record<string, string>; method: "PUT"; url: string };
    };
    try {
      const uploadResponse = await fetch(initiated.upload.url, {
        method: initiated.upload.method,
        headers: initiated.upload.headers,
        body: file,
      });
      if (!uploadResponse.ok)
        throw new Error("The file could not be uploaded to storage.");
    } catch (uploadError) {
      await fetch(
        `/api/data-sources/${encodeURIComponent(initiated.data.id)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
      throw uploadError;
    }
    const completeResponse = await fetch(
      `/api/data-sources/${encodeURIComponent(initiated.data.id)}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    if (!completeResponse.ok)
      throw new Error(
        await responseMessage(
          completeResponse,
          "The uploaded file could not be processed. Retry before removing the connector.",
        ),
      );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (fileConnector) {
        await submitFile();
      } else {
        const response = await fetch("/api/data-sources/databases", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            databaseRequest(type, new FormData(event.currentTarget)),
          ),
        });
        if (!response.ok)
          throw new Error(
            await responseMessage(
              response,
              "The database could not be connected.",
            ),
          );
      }
      router.push("/connectors");
      router.refresh();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "The connector could not be created.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={`${styles.page} ${styles.setupPage}`}>
      <Link className={styles.backLink} href="/connectors/new">
        <ArrowLeft aria-hidden="true" size={15} /> All connectors
      </Link>
      <header className={styles.setupIntro}>
        <span className={styles.setupConnectorIcon} data-connector={type}>
          <Icon aria-hidden="true" />
        </span>
        <div>
          <h1>Connect {connector.label}</h1>
          <p>{connector.description}</p>
        </div>
      </header>

      <div className={styles.setupLayout}>
        <form className={styles.formCard} onSubmit={submit}>
          <div className={styles.formBody}>
            {fileConnector ? (
              <>
                <FormSection
                  description="This is how the source will appear in your workspace."
                  title="Source"
                >
                  <TextField
                    className={styles.fieldWide}
                    isRequired
                    label="Connector name"
                    onChange={setName}
                    value={name}
                    placeholder={`My ${connector.label} data`}
                  />
                </FormSection>
                <FormSection
                  description={`Select one ${type.toUpperCase()} file from your computer.`}
                  title="File"
                >
                  <div className={styles.fieldWide}>
                    <FileDropZone
                      acceptedFileTypes={[...fileTypes[type]]}
                      buttonLabel="Browse files"
                      className={styles.fileDropZone}
                      description={`.${type} · one file`}
                      label={
                        file ? "Choose a different file" : "Drop file here"
                      }
                      onSelect={selectFile}
                    />
                    {file ? (
                      <div className={styles.selectedFile}>
                        <div>
                          <strong>{file.name}</strong>
                          <span>
                            {new Intl.NumberFormat("en", {
                              style: "unit",
                              unit: "megabyte",
                              maximumFractionDigits: 2,
                            }).format(file.size / 1_000_000)}
                          </span>
                        </div>
                        <Button
                          onPress={() => setFile(null)}
                          size="sm"
                          variant="ghost"
                        >
                          Remove
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </FormSection>
              </>
            ) : (
              <>
                <FormSection
                  description="This is how the source will appear in your workspace."
                  title="Source"
                >
                  <TextField
                    className={styles.fieldWide}
                    isRequired
                    label="Connector name"
                    name="name"
                    placeholder={`Production ${connector.label}`}
                  />
                </FormSection>
                <DatabaseFields type={type} />
              </>
            )}
          </div>
          <div className={styles.formActions}>
            {error ? (
              <p className={styles.formError} role="alert">
                {error}
              </p>
            ) : null}
            <Button
              isDisabled={submitting}
              onPress={() => router.push("/connectors/new")}
              variant="secondary"
            >
              Cancel
            </Button>
            <Button
              className={styles.primaryAction}
              isPending={submitting}
              type="submit"
            >
              {fileConnector ? "Upload and connect" : "Test and connect"}
            </Button>
          </div>
        </form>

        <aside className={styles.setupAside}>
          <div className={styles.asideHeading}>
            <LockKeyhole aria-hidden="true" />
            <h2>What happens next</h2>
          </div>
          <ul>
            {(fileConnector
              ? [
                  "The file is uploaded securely",
                  "Its structure is validated",
                  "The source appears in Connectors",
                ]
              : [
                  "The connection is tested",
                  "Credentials are encrypted",
                  "Access remains read-only",
                ]
            ).map((item) => (
              <li key={item}>
                <Check aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <p>
            {fileConnector
              ? "The connector is created only after processing begins."
              : "Nothing is saved if the connection test fails."}
          </p>
        </aside>
      </div>
    </div>
  );
}

# 🚀 Getting started with Strapi

Strapi comes with a full featured [Command Line Interface](https://docs.strapi.io/dev-docs/cli) (CLI) which lets you scaffold and manage your project in seconds.

### `develop`

Start your Strapi application with autoReload enabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-develop)

```
npm run develop
# or
yarn develop
```

### `start`

Start your Strapi application with autoReload disabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-start)

```
npm run start
# or
yarn start
```

### `build`

Build your admin panel. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-build)

```
npm run build
# or
yarn build
```

## ⚙️ Deployment

Strapi gives you many possible deployment options for your project including [Strapi Cloud](https://cloud.strapi.io). Browse the [deployment section of the documentation](https://docs.strapi.io/dev-docs/deployment) to find the best solution for your use case.

```
yarn strapi deploy
```

## 📚 Learn more

- [Resource center](https://strapi.io/resource-center) - Strapi resource center.
- [Strapi documentation](https://docs.strapi.io) - Official Strapi documentation.
- [Strapi tutorials](https://strapi.io/tutorials) - List of tutorials made by the core team and the community.
- [Strapi blog](https://strapi.io/blog) - Official Strapi blog containing articles made by the Strapi team and the community.
- [Changelog](https://strapi.io/changelog) - Find out about the Strapi product updates, new features and general improvements.

Feel free to check out the [Strapi GitHub repository](https://github.com/strapi/strapi). Your feedback and contributions are welcome!

## ✨ Community

- [Discord](https://discord.strapi.io) - Come chat with the Strapi community including the core team.
- [Forum](https://forum.strapi.io/) - Place to discuss, ask questions and find answers, show your Strapi project and get feedback or just talk with other Community members.
- [Awesome Strapi](https://github.com/strapi/awesome-strapi) - A curated list of awesome things related to Strapi.

---

<sub>🤫 Psst! [Strapi is hiring](https://strapi.io/careers).</sub>

## Official node-network import

This project can sync official node-network datasets into Strapi `node` and `node-connection` entries.

1. Add a `node-network` entry in Strapi.
2. Fill `source_config` with a GeoJSON pair config such as:

```json
{
  "provider": "geojson-pair",
  "nodesUrl": "https://example.com/nodes.geojson",
  "connectionsUrl": "https://example.com/connections.geojson",
  "nodeIdField": "knoop_id",
  "nodeNumberField": "knoopnr",
  "connectionFromField": "startnr",
  "connectionToField": "eindnr",
  "distanceField": "afstand",
  "distanceUnit": "km"
}
```

3. Set `sync_enabled` to `true`.
4. Set `NODE_NETWORK_SYNC_TOKEN` to allow manual sync calls.

The importer updates existing nodes by `external_id`, creates missing nodes, updates connections, and removes stale connections for the synced network.

Manual sync:

```bash
curl -X POST \
  -H "Authorization: Bearer $NODE_NETWORK_SYNC_TOKEN" \
  http://localhost:1337/api/node-networks/1/sync
```

CLI sync:

```bash
npm run import:node-network -- 1
```

CLI sync by phase:

```bash
npm run import:node-network -- 1 -- 1
npm run import:node-network -- 1 -- 2
```

## Belgian city import

This project can import Belgian municipalities into Strapi `city` entries.

Supported source formats:

- GeoJSON `FeatureCollection`
- JSON array of records

Expected fields are matched heuristically. The importer looks for common keys such as:

- `name`, `naam`, `municipality`, `gemeente`, `city`
- `postal_code`, `postcode`, `zip`
- `province`, `provincie`
- `region`, `regio`
- `latitude`, `lat`, `y`
- `longitude`, `lng`, `lon`, `x`

When the source is GeoJSON, polygon boundaries are stored in `boundary_geojson` and centroids are computed automatically. The importer also ensures Belgium, the three regions, and the ten provinces exist before importing cities.

CLI import with the built-in Belgian municipalities source:

```bash
npm run import:belgian-cities
```

CLI import with a custom file or URL:

```bash
npm run import:belgian-cities -- ./data/belgian-municipalities.geojson
```

Dry run:

```bash
npm run import:belgian-cities -- ./data/belgian-municipalities.geojson --dry-run
```

Import a subset:

```bash
npm run import:belgian-cities -- ./data/belgian-municipalities.geojson --limit 10
```

## Dutch city import

This project can import Dutch municipalities into Strapi `city` entries.

Built-in import:

```bash
npm run import:dutch-cities
```

Dry run:

```bash
npm run import:dutch-cities -- --dry-run --limit 20
```

The importer uses the public `georef-netherlands-gemeente` dataset and stores municipality names, centroids, boundaries, and province relations. `city.country` is derived from the matched province's `country` relation when available.

## Legacy walk import

This project can import legacy walking routes from the old Routezoeker MySQL database and local media folders.

Dry run:

```bash
npm run import:legacy-walks -- --dry-run --limit 5
```

Import:

```bash
npm run import:legacy-walks
```

Optional overrides:

```bash
npm run import:legacy-walks -- --config /path/to/config.php --legacy-root /path/to/legacy/site --host 127.0.0.1
```

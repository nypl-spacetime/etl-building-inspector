# Space/Time ETL module: Building Inspector

[ETL](https://en.wikipedia.org/wiki/Extract,_transform,_load) module for NYPL's [NYC Space/Time Direcory](http://spacetime.nypl.org/). This Node.js module downloads, parses, and/or transforms Building Inspector data to a NYC Space/Time Directory dataset.

## Details

<table>
  <tbody>

    <tr>
      <td>ID</td>
      <td><code>building-inspector</code></td>
    </tr>

    <tr>
      <td>Title</td>
      <td>Building Inspector</td>
    </tr>

    <tr>
      <td>Description</td>
      <td>Data from the Building Inspector API; contains placenames, address numbers and building footprints obtained from 19th century fire insurance atlases included in the Atlases of New York City Collection at The New York Public Library.</td>
    </tr>

    <tr>
      <td>License</td>
      <td>CC0</td>
    </tr>

    <tr>
      <td>Author</td>
      <td>NYPL</td>
    </tr>

    <tr>
      <td>Website</td>
      <td><a href="http://buildinginspector.nypl.org/">http://buildinginspector.nypl.org/</a></td>
    </tr>
  </tbody>
</table>

## Available steps

  - `download`
  - `transform`

## Usage

```
git clone https://github.com/nypl-spacetime/etl-building-inspector.git /path/to/etl-modules
cd /path/to/etl-modules/etl-building-inspector
npm install

spacetime-etl building-inspector [<step>]
```

See http://github.com/nypl-spacetime/spacetime-etl for information about Space/Time's ETL tool. More Space/Time ETL modules [can be found on GitHub](https://github.com/search?utf8=%E2%9C%93&q=org%3Anypl-spacetime+etl-&type=Repositories&ref=advsearch&l=&l=).

# Data

The dataset created by this ETL module's `transform` step can be found in the [data section of the NYC Space/Time Directory website](http://spacetime.nypl.org/#data-building-inspector).

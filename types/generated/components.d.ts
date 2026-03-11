import type { Schema, Struct } from '@strapi/strapi';

export interface BlogImage extends Struct.ComponentSchema {
  collectionName: 'components_blog_images';
  info: {
    displayName: 'image';
    icon: 'landscape';
  };
  attributes: {
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
  };
}

export interface BlogQuote extends Struct.ComponentSchema {
  collectionName: 'components_blog_quotes';
  info: {
    displayName: 'quote';
  };
  attributes: {
    author: Schema.Attribute.String;
    text: Schema.Attribute.Text;
  };
}

export interface BlogRichText extends Struct.ComponentSchema {
  collectionName: 'components_blog_rich_texts';
  info: {
    displayName: 'rich text';
  };
  attributes: {
    body: Schema.Attribute.Blocks;
  };
}

export interface GeneralSeo extends Struct.ComponentSchema {
  collectionName: 'components_general_seos';
  info: {
    displayName: 'seo';
    icon: 'check';
  };
  attributes: {
    canonical: Schema.Attribute.String;
    meta_description: Schema.Attribute.Text;
    meta_title: Schema.Attribute.Text;
    og_image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    robots: Schema.Attribute.Enumeration<
      [
        'index, follow',
        'noindex, nofollow',
        'index, nofollow',
        'noindex, follow',
      ]
    >;
  };
}

export interface PageBlocksArticleGrid extends Struct.ComponentSchema {
  collectionName: 'components_page_blocks_article_grids';
  info: {
    displayName: 'article_grid';
    icon: 'apps';
  };
  attributes: {
    card: Schema.Attribute.Component<'page-blocks.cards', true>;
    subtitle: Schema.Attribute.String;
    title: Schema.Attribute.String;
  };
}

export interface PageBlocksCards extends Struct.ComponentSchema {
  collectionName: 'components_page_blocks_cards';
  info: {
    displayName: 'cards';
  };
  attributes: {
    description: Schema.Attribute.Text;
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    label: Schema.Attribute.String;
    link: Schema.Attribute.String;
    title: Schema.Attribute.String;
  };
}

export interface PageBlocksCarouselItem extends Struct.ComponentSchema {
  collectionName: 'components_page_blocks_carousel_items';
  info: {
    displayName: 'carousel_item';
  };
  attributes: {
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    link: Schema.Attribute.String;
    subtitle: Schema.Attribute.String;
    title: Schema.Attribute.String;
  };
}

export interface PageBlocksHeroBanner extends Struct.ComponentSchema {
  collectionName: 'components_page_blocks_hero_banners';
  info: {
    displayName: 'hero_banner';
    icon: 'gate';
  };
  attributes: {
    align: Schema.Attribute.Enumeration<['left', 'center', 'right']> &
      Schema.Attribute.DefaultTo<'center'>;
    background_image: Schema.Attribute.Media<
      'images' | 'files' | 'videos' | 'audios'
    >;
    button_label: Schema.Attribute.String;
    button_link: Schema.Attribute.String;
    eyebrow: Schema.Attribute.String;
    subtitle: Schema.Attribute.String;
    title: Schema.Attribute.String;
  };
}

export interface PageBlocksImageCarousel extends Struct.ComponentSchema {
  collectionName: 'components_page_blocks_image_carousels';
  info: {
    displayName: 'image_carousel';
  };
  attributes: {
    item: Schema.Attribute.Component<'page-blocks.carousel-item', true>;
    subtitle: Schema.Attribute.String;
    title: Schema.Attribute.String;
  };
}

export interface PageBlocksImageGallery extends Struct.ComponentSchema {
  collectionName: 'components_page_blocks_image_galleries';
  info: {
    displayName: 'image_gallery';
    icon: 'landscape';
  };
  attributes: {
    button_label: Schema.Attribute.String &
      Schema.Attribute.DefaultTo<"Toon alle foto's">;
    images: Schema.Attribute.Media<
      'images' | 'files' | 'videos' | 'audios',
      true
    >;
    layout: Schema.Attribute.Enumeration<['grid', 'masonry', 'hero']>;
    show_button: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
  };
}

export interface PageBlocksImageText extends Struct.ComponentSchema {
  collectionName: 'components_page_blocks_image_texts';
  info: {
    displayName: 'image_text';
  };
  attributes: {
    button_label: Schema.Attribute.String;
    button_link: Schema.Attribute.String;
    content: Schema.Attribute.Blocks;
    eyebrow: Schema.Attribute.String;
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    image_position: Schema.Attribute.Enumeration<['left', 'right']> &
      Schema.Attribute.DefaultTo<'right'>;
    title: Schema.Attribute.String;
  };
}

export interface PageBlocksList extends Struct.ComponentSchema {
  collectionName: 'components_page_blocks_lists';
  info: {
    displayName: 'list';
    icon: 'bulletList';
  };
  attributes: {
    active: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<true>;
    type: Schema.Attribute.Enumeration<['list', 'map']> &
      Schema.Attribute.DefaultTo<'list'>;
  };
}

export interface PageBlocksQuote extends Struct.ComponentSchema {
  collectionName: 'components_page_blocks_quotes';
  info: {
    displayName: 'quote';
  };
  attributes: {
    author: Schema.Attribute.String;
    text: Schema.Attribute.String;
  };
}

export interface PageBlocksRegionSlider extends Struct.ComponentSchema {
  collectionName: 'components_page_blocks_region_sliders';
  info: {
    displayName: 'region_slider';
  };
  attributes: {
    button_label: Schema.Attribute.String;
    button_link: Schema.Attribute.String;
    regions: Schema.Attribute.Relation<'oneToMany', 'api::region.region'>;
    source: Schema.Attribute.Enumeration<['province', 'country', 'manual']> &
      Schema.Attribute.DefaultTo<'province'>;
    subtitle: Schema.Attribute.String;
    title: Schema.Attribute.String;
  };
}

export interface PageBlocksTextSection extends Struct.ComponentSchema {
  collectionName: 'components_page_blocks_text_sections';
  info: {
    displayName: 'text_section';
    icon: 'bulletList';
  };
  attributes: {
    content: Schema.Attribute.Blocks;
    max_width: Schema.Attribute.Enumeration<
      ['default', 'narrow', 'wide', 'full']
    > &
      Schema.Attribute.DefaultTo<'default'>;
    title: Schema.Attribute.String;
  };
}

export interface RouteRouteEndLocation extends Struct.ComponentSchema {
  collectionName: 'components_route_route_end_locations';
  info: {
    displayName: 'route_end_location';
  };
  attributes: {
    address: Schema.Attribute.Component<'shared.address', false>;
    description: Schema.Attribute.Text;
    name: Schema.Attribute.String;
  };
}

export interface RouteRouteMarkings extends Struct.ComponentSchema {
  collectionName: 'components_route_route_markings';
  info: {
    displayName: 'route_markings';
  };
  attributes: {
    color: Schema.Attribute.String;
    description: Schema.Attribute.Text;
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    marking_type: Schema.Attribute.Enumeration<
      ['symbol', 'knooppunten', 'numbers', 'paint_marks', 'mixed']
    >;
    name: Schema.Attribute.String;
  };
}

export interface RouteRouteNodes extends Struct.ComponentSchema {
  collectionName: 'components_route_route_nodes';
  info: {
    displayName: 'route_nodes';
  };
  attributes: {
    node: Schema.Attribute.Relation<'oneToOne', 'api::node.node'>;
    order: Schema.Attribute.Integer;
  };
}

export interface RouteRouteParkingLocation extends Struct.ComponentSchema {
  collectionName: 'components_route_route_parking_locations';
  info: {
    displayName: 'Route Parking Location';
  };
  attributes: {
    address: Schema.Attribute.Component<'shared.address', false>;
    description: Schema.Attribute.Text;
    name: Schema.Attribute.String;
  };
}

export interface RouteRouteStartLocation extends Struct.ComponentSchema {
  collectionName: 'components_route_route_start_locations';
  info: {
    displayName: 'route_start_location';
  };
  attributes: {
    address: Schema.Attribute.Component<'shared.address', false>;
    description: Schema.Attribute.Text;
    distance_km: Schema.Attribute.Decimal;
    duration_minutes: Schema.Attribute.Integer;
    elevation_gain: Schema.Attribute.Integer;
    elevation_loss: Schema.Attribute.Integer;
    elevation_profile: Schema.Attribute.JSON;
    gpx_file: Schema.Attribute.Media;
    name: Schema.Attribute.String;
    read_out_gpx: Schema.Attribute.Boolean & Schema.Attribute.DefaultTo<false>;
    route_geometry: Schema.Attribute.JSON;
    surface_percentage_hard: Schema.Attribute.Integer;
  };
}

export interface RouteRouteWaypoints extends Struct.ComponentSchema {
  collectionName: 'components_route_route_waypoints';
  info: {
    displayName: 'route_waypoints';
  };
  attributes: {
    description: Schema.Attribute.Blocks;
    gallery: Schema.Attribute.Media<
      'images' | 'files' | 'videos' | 'audios',
      true
    >;
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    latitude: Schema.Attribute.Decimal;
    longitude: Schema.Attribute.Decimal;
    title: Schema.Attribute.String;
    waypoint_type: Schema.Attribute.Enumeration<
      [
        'viewpoint',
        'nature',
        'waterfall',
        'castle',
        'cafe',
        'restaurant',
        'parking',
        'info',
        'landmark',
        'picnic',
      ]
    >;
  };
}

export interface SharedAddress extends Struct.ComponentSchema {
  collectionName: 'components_shared_addresses';
  info: {
    displayName: 'address';
  };
  attributes: {
    city: Schema.Attribute.Relation<'oneToOne', 'api::city.city'>;
    country: Schema.Attribute.Relation<'oneToOne', 'api::country.country'>;
    house_number: Schema.Attribute.String;
    latitude: Schema.Attribute.Decimal;
    longitude: Schema.Attribute.Decimal;
    postal_code: Schema.Attribute.String;
    province: Schema.Attribute.Relation<'oneToOne', 'api::province.province'>;
    region: Schema.Attribute.Relation<'oneToOne', 'api::region.region'>;
    street: Schema.Attribute.String;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'blog.image': BlogImage;
      'blog.quote': BlogQuote;
      'blog.rich-text': BlogRichText;
      'general.seo': GeneralSeo;
      'page-blocks.article-grid': PageBlocksArticleGrid;
      'page-blocks.cards': PageBlocksCards;
      'page-blocks.carousel-item': PageBlocksCarouselItem;
      'page-blocks.hero-banner': PageBlocksHeroBanner;
      'page-blocks.image-carousel': PageBlocksImageCarousel;
      'page-blocks.image-gallery': PageBlocksImageGallery;
      'page-blocks.image-text': PageBlocksImageText;
      'page-blocks.list': PageBlocksList;
      'page-blocks.quote': PageBlocksQuote;
      'page-blocks.region-slider': PageBlocksRegionSlider;
      'page-blocks.text-section': PageBlocksTextSection;
      'route.route-end-location': RouteRouteEndLocation;
      'route.route-markings': RouteRouteMarkings;
      'route.route-nodes': RouteRouteNodes;
      'route.route-parking-location': RouteRouteParkingLocation;
      'route.route-start-location': RouteRouteStartLocation;
      'route.route-waypoints': RouteRouteWaypoints;
      'shared.address': SharedAddress;
    }
  }
}
